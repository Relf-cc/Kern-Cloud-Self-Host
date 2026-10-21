// Account overview, the personal space, workspaces, members and invitations.

import { Hono, type Context } from "hono";
import { z } from "zod";
import { config } from "../config.js";
import { one, pool, query, tx, type Db } from "../db.js";
import { inviteMail, send } from "../mail.js";
import { badRequest, body, conflict, forbidden, HttpError, iso, notFound, requireUser, requireVerified, type Env } from "../lib/http.js";
import { audit, ensurePersonal, memberIds, membership, ROLE_RANK, serializeSpace, type Role, type SpaceRow } from "../lib/spaces.js";
import { broadcastSpace, evict, issueTicket, notifyUser } from "../realtime.js";
import { live } from "../live.js";
import { redeem } from "../workspace-keys.js";

const TEAM_SIZES = ["just-me", "2-10", "11-50", "51-200", "201-1000", "1000+"] as const;

const logo = z
  .string()
  .max(Math.ceil(config.limits.logoBytes * 1.4))
  .regex(/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/, "Logos must be PNG, JPEG, WebP or GIF images.");
const slug = z
  .string()
  .min(3)
  .max(40)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, "Use lowercase letters, numbers and dashes.");
const optText = (max: number) => z.string().trim().max(max).nullable().optional();

const details = {
  description: z.string().trim().max(500).optional(),
  logo: logo.nullable().optional(),
  accent: z.string().max(32).regex(/^[a-z]+$|^#[0-9a-fA-F]{6}$/).nullable().optional(),
  website: z.union([z.url().max(200), z.literal("")]).nullable().optional(),
  industry: optText(60),
  teamSize: z.enum(TEAM_SIZES).nullable().optional(),
  useCase: optText(60),
  timezone: optText(64),
  githubOrg: z.string().max(39).regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/, "That isn't a GitHub organisation name.").nullable().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
};

const inviteInput = z.object({
  email: z.email().max(254),
  role: z.enum(["admin", "member", "viewer"]).default("member"),
});

const createBody = z.object({
  name: z.string().trim().min(1, "Give the workspace a name.").max(80),
  /**
   * A workspace key, when this instance requires one (WORKSPACE_KEYS).
   * Ignored when it doesn't, so a client may always send one.
   */
  key: z.string().trim().max(64).optional(),
  slug: slug.optional(),
  ...details,
  invites: z.array(inviteInput).max(50).optional(),
  inviteMessage: z.string().trim().max(500).optional(),
});

const updateBody = z.object({ name: z.string().trim().min(1).max(80).optional(), slug: slug.optional(), ...details });

const COLUMN: Record<string, string> = {
  name: "name",
  slug: "slug",
  description: "description",
  logo: "logo",
  accent: "accent",
  website: "website",
  industry: "industry",
  teamSize: "team_size",
  useCase: "use_case",
  timezone: "timezone",
  githubOrg: "github_org",
  settings: "settings",
};

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return base.length >= 3 ? base : `${base || "workspace"}-${Math.random().toString(36).slice(2, 6)}`;
}

async function uniqueSlug(wanted: string, db: Db, exceptId?: string): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? wanted : `${wanted.slice(0, 36)}-${i + 1}`;
    const taken = await one("SELECT 1 FROM kern_space WHERE lower(slug) = $1 AND deleted_at IS NULL AND id IS DISTINCT FROM $2", [candidate, exceptId ?? null], db);
    if (!taken) return candidate;
  }
  return `${wanted.slice(0, 30)}-${Date.now().toString(36)}`;
}

const inviteLink = (id: string) => `${config.linkUrl}/kern/invite/${id}`;

interface InviteRow {
  id: string;
  space_id: string;
  email: string;
  role: Exclude<Role, "owner">;
  message: string | null;
  invited_by: string | null;
  created_at: Date;
  expires_at: Date;
  last_sent_at: Date | null;
  send_count: number;
  accepted_at: Date | null;
  declined_at: Date | null;
  revoked_at: Date | null;
}

function inviteStatus(i: InviteRow): "pending" | "accepted" | "declined" | "revoked" | "expired" {
  if (i.accepted_at) return "accepted";
  if (i.revoked_at) return "revoked";
  if (i.declined_at) return "declined";
  if (i.expires_at.getTime() < Date.now()) return "expired";
  return "pending";
}

function serializeInvite(i: InviteRow & { inviter_name?: string | null }) {
  return {
    id: i.id,
    spaceId: i.space_id,
    email: i.email,
    role: i.role,
    message: i.message,
    invitedBy: i.invited_by,
    inviterName: i.inviter_name ?? null,
    createdAt: iso(i.created_at),
    expiresAt: iso(i.expires_at),
    lastSentAt: iso(i.last_sent_at),
    sendCount: i.send_count,
    status: inviteStatus(i),
    link: inviteLink(i.id),
  };
}

/** Creates (or refreshes) invitations and emails them. Returns per-email results. */
async function createInvites(
  space: SpaceRow,
  inviter: { id: string; name: string; email: string },
  list: { email: string; role: Exclude<Role, "owner"> }[],
  message: string | null,
) {
  const results: { email: string; ok: boolean; reason?: string; invite?: ReturnType<typeof serializeInvite> }[] = [];
  const seen = new Set<string>();
  const memberCount = await one<{ n: number }>("SELECT count(*)::int AS n FROM kern_member WHERE space_id = $1", [space.id]);
  let room = config.limits.membersPerWorkspace - (memberCount?.n ?? 0);
  for (const item of list) {
    const email = item.email.trim().toLowerCase();
    if (seen.has(email)) continue;
    seen.add(email);
    if (email === inviter.email.toLowerCase()) {
      results.push({ email, ok: false, reason: "That's you." });
      continue;
    }
    const already = await one("SELECT 1 FROM kern_member m JOIN \"user\" u ON u.id = m.user_id WHERE m.space_id = $1 AND lower(u.email) = $2", [space.id, email]);
    if (already) {
      results.push({ email, ok: false, reason: "Already a member." });
      continue;
    }
    if (room <= 0) {
      results.push({ email, ok: false, reason: "The workspace is full." });
      continue;
    }
    const expires = new Date(Date.now() + config.inviteDays * 86_400_000);
    // Re-inviting refreshes the open invitation instead of creating another.
    const row = await one<InviteRow>(
      `INSERT INTO kern_invite(space_id, email, role, message, invited_by, expires_at) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (space_id, lower(email)) WHERE accepted_at IS NULL AND declined_at IS NULL AND revoked_at IS NULL
       DO UPDATE SET role = EXCLUDED.role, message = EXCLUDED.message, invited_by = EXCLUDED.invited_by, expires_at = EXCLUDED.expires_at
       RETURNING *`,
      [space.id, email, item.role, message, inviter.id, expires],
    );
    try {
      await send(inviteMail({ to: email, inviter: inviter.name || inviter.email, workspace: space.name, role: item.role, message, link: inviteLink(row!.id), expiresAt: expires }));
      await query("UPDATE kern_invite SET last_sent_at = now(), send_count = send_count + 1 WHERE id = $1", [row!.id]);
      room--;
      results.push({ email, ok: true, invite: serializeInvite({ ...row!, inviter_name: inviter.name }) });
    } catch (e) {
      console.error("[invite] send failed", e);
      results.push({ email, ok: false, reason: "The email couldn't be sent. Try again later.", invite: serializeInvite({ ...row!, inviter_name: inviter.name }) });
    }
    // If the invitee already has an account and is online, tell their app.
    const invitee = await one<{ id: string }>("SELECT id FROM \"user\" WHERE lower(email) = $1", [email]);
    if (invitee) notifyUser(invitee.id, { type: "invite", invite: { id: row!.id, spaceId: space.id, workspace: space.name, logo: space.logo, inviterName: inviter.name, role: item.role } });
  }
  if (results.some((r) => r.ok)) await audit(space.id, inviter.id, "members.invited", { emails: results.filter((r) => r.ok).map((r) => r.email) });
  return results;
}

async function workspaceList(userId: string) {
  const rows = await query<SpaceRow & { role: Role; member_count: number }>(
    `SELECT s.*, m.role, (SELECT count(*)::int FROM kern_member x WHERE x.space_id = s.id) AS member_count
     FROM kern_space s JOIN kern_member m ON m.space_id = s.id
     WHERE m.user_id = $1 AND s.deleted_at IS NULL AND s.kind = 'workspace'
     ORDER BY s.name`,
    [userId],
  );
  return rows.map(({ role, member_count, ...s }) => serializeSpace(s as SpaceRow, role, { memberCount: member_count }));
}

async function pendingInvitesFor(email: string) {
  const rows = await query<InviteRow & { inviter_name: string | null; space_name: string; space_logo: string | null }>(
    `SELECT i.*, u.name AS inviter_name, s.name AS space_name, s.logo AS space_logo FROM kern_invite i
     JOIN kern_space s ON s.id = i.space_id AND s.deleted_at IS NULL
     LEFT JOIN "user" u ON u.id = i.invited_by
     WHERE lower(i.email) = lower($1) AND i.accepted_at IS NULL AND i.declined_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
     ORDER BY i.created_at DESC`,
    [email],
  );
  return rows.map((r) => ({ ...serializeInvite(r), workspace: r.space_name, logo: r.space_logo }));
}

async function members(spaceId: string) {
  const rows = await query<{ user_id: string; role: Role; title: string | null; joined_at: Date; name: string; email: string; image: string | null }>(
    `SELECT m.user_id, m.role, m.title, m.joined_at, u.name, u.email, u.image FROM kern_member m JOIN "user" u ON u.id = m.user_id
     WHERE m.space_id = $1 ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 ELSE 3 END, u.name`,
    [spaceId],
  );
  return rows.map((r) => ({ userId: r.user_id, role: r.role, title: r.title, joinedAt: iso(r.joined_at), name: r.name, email: r.email, image: r.image }));
}

/** Tells every member's app that a workspace changed. */
async function announce(spaceId: string, event: string, extra: Record<string, unknown> = {}) {
  for (const id of await memberIds(spaceId)) notifyUser(id, { type: "space", event, space: spaceId, ...extra });
}

/** Where a client may put a workspace key, besides the request body. */
const KEY_HEADER = "x-kern-workspace-key";

/**
 * Enforces WORKSPACE_KEYS on workspace creation and returns the key's id for
 * the audit entry, or null when this instance doesn't ask for one.
 *
 * Refusals say what to do next, because the person reading them has a choice:
 * ask whoever runs this instance for a key, or run their own server with Kern
 * Platform, where no key is needed at all.
 */
async function checkWorkspaceKey(c: Context<Env>, userId: string, fromBody: string | undefined): Promise<string | null> {
  if (live.workspaceKeys !== "required") return null;
  const presented = (fromBody ?? c.req.header(KEY_HEADER) ?? "").trim();
  const elsewhere = `Ask whoever runs ${live.instanceName} for a key, or run your own server with Kern Platform, which needs none.`;
  if (!presented) {
    throw new HttpError(403, "workspace_key_required", `Creating a workspace on ${live.instanceName} needs a key. ${elsewhere}`);
  }
  const result = await redeem(presented, userId);
  if (result.ok) return result.id;
  const why: Record<typeof result.reason, string> = {
    malformed: "That doesn't look like a workspace key. They read k_ followed by 32 characters.",
    unknown: "That workspace key isn't one this server issued.",
    revoked: "That workspace key has been revoked.",
    taken: "That workspace key already belongs to another account. A key is claimed by the first account that uses it.",
  };
  throw new HttpError(403, "workspace_key_invalid", `${why[result.reason]} ${elsewhere}`);
}

export const workspaces = new Hono<Env>();
workspaces.use("*", requireUser);

// ------------------------------------------------------------ me

workspaces.get("/me", async (c) => {
  const user = c.get("user");
  const u = await one<{ created_at: Date }>(`SELECT "createdAt" AS created_at FROM "user" WHERE id = $1`, [user.id]);
  const personal = await one<SpaceRow>("SELECT * FROM kern_space WHERE owner_id = $1 AND kind = 'personal'", [user.id]);
  return c.json({
    user: { ...user, createdAt: iso(u?.created_at) },
    personal: personal ? serializeSpace(personal, "owner") : null,
    workspaces: await workspaceList(user.id),
    invites: user.emailVerified ? await pendingInvitesFor(user.email) : [],
  });
});

/** Creates the personal cloud space on first use. */
workspaces.post("/me/personal", async (c) => {
  const user = c.get("user");
  const s = await ensurePersonal(user);
  return c.json(serializeSpace(s, "owner"));
});

workspaces.post("/realtime/ticket", (c) => c.json(issueTicket(c.get("user"))));

// ------------------------------------------------------------ workspaces

workspaces.get("/workspaces", async (c) => c.json(await workspaceList(c.get("user").id)));

workspaces.get("/workspaces/slug-available", async (c) => {
  const wanted = (c.req.query("slug") ?? "").toLowerCase();
  if (!slug.safeParse(wanted).success) return c.json({ available: false, suggestion: slugify(wanted || "workspace") });
  const taken = await one("SELECT 1 FROM kern_space WHERE lower(slug) = $1 AND deleted_at IS NULL", [wanted]);
  return c.json({ available: !taken, suggestion: taken ? await uniqueSlug(wanted, pool) : wanted });
});

workspaces.post("/workspaces", async (c) => {
  const user = c.get("user");
  requireVerified(user);
  const input = await body(c, createBody);
  // Creating a workspace may take a key on this instance. Joining one never
  // does, and the personal space isn't a workspace, so neither reaches here.
  const keyId = await checkWorkspaceKey(c, user.id, input.key);
  const owned = await one<{ n: number }>("SELECT count(*)::int AS n FROM kern_space WHERE owner_id = $1 AND kind = 'workspace' AND deleted_at IS NULL", [user.id]);
  if ((owned?.n ?? 0) >= config.limits.workspacesPerUser) throw conflict(`You can own up to ${config.limits.workspacesPerUser} workspaces.`, "limit");

  const space = await tx(async (db) => {
    const s = await uniqueSlug(input.slug ?? slugify(input.name), db);
    const row = await one<SpaceRow>(
      `INSERT INTO kern_space(kind, owner_id, name, slug, description, logo, accent, website, industry, team_size, use_case, timezone, github_org, settings)
       VALUES ('workspace', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
      [
        user.id,
        input.name,
        s,
        input.description ?? "",
        input.logo ?? null,
        input.accent ?? null,
        input.website || null,
        input.industry ?? null,
        input.teamSize ?? null,
        input.useCase ?? null,
        input.timezone ?? null,
        input.githubOrg ?? null,
        JSON.stringify(input.settings ?? {}),
      ],
      db,
    );
    await query("INSERT INTO kern_member(space_id, user_id, role) VALUES ($1, $2, 'owner')", [row!.id, user.id], db);
    await audit(row!.id, user.id, "workspace.created", keyId ? { name: input.name, key: keyId } : { name: input.name }, db);
    return row!;
  });

  const invites = input.invites?.length ? await createInvites(space, user, input.invites, input.inviteMessage ?? null) : [];
  return c.json({ workspace: serializeSpace(space, "owner", { memberCount: 1 }), invites }, 201);
});

workspaces.get("/workspaces/:id", async (c) => {
  const user = c.get("user");
  const m = await membership(user.id, c.req.param("id"));
  const isAdmin = ROLE_RANK[m.role] >= ROLE_RANK.admin;
  const invites = isAdmin
    ? (
        await query<InviteRow & { inviter_name: string | null }>(
          `SELECT i.*, u.name AS inviter_name FROM kern_invite i LEFT JOIN "user" u ON u.id = i.invited_by
           WHERE i.space_id = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL ORDER BY i.created_at DESC LIMIT 200`,
          [m.space.id],
        )
      ).map(serializeInvite)
    : [];
  const list = await members(m.space.id);
  return c.json({ workspace: serializeSpace(m.space, m.role, { memberCount: list.length }), members: list, invites });
});

workspaces.patch("/workspaces/:id", async (c) => {
  const user = c.get("user");
  const input = await body(c, updateBody);
  const updated = await tx(async (db) => {
    const m = await membership(user.id, c.req.param("id"), "admin", db);
    if (m.space.kind !== "workspace") throw badRequest("Your personal space can't be changed here.");
    const sets: string[] = [];
    const params: unknown[] = [m.space.id];
    for (const [k, v] of Object.entries(input)) {
      if (v === undefined || !COLUMN[k]) continue;
      let value: unknown = v;
      if (k === "slug") value = await uniqueSlug(v as string, db, m.space.id);
      if (k === "website" && v === "") value = null;
      if (k === "settings") value = JSON.stringify({ ...m.space.settings, ...(v as object) });
      params.push(value);
      sets.push(`${COLUMN[k]} = $${params.length}`);
    }
    if (!sets.length) return m;
    const row = await one<SpaceRow>(`UPDATE kern_space SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 RETURNING *`, params, db);
    await audit(m.space.id, user.id, "workspace.updated", { fields: Object.keys(input) }, db);
    return { space: row!, role: m.role };
  });
  await announce(updated.space.id, "updated");
  return c.json(serializeSpace(updated.space, updated.role));
});

/** Records that the workspace's GitHub organisation was imported. */
workspaces.post("/workspaces/:id/github-synced", async (c) => {
  const user = c.get("user");
  const input = await body(c, z.object({ org: z.string().max(39), repos: z.number().int().min(0).max(10_000) }));
  const m = await membership(user.id, c.req.param("id"), "admin");
  await query("UPDATE kern_space SET github_org = $2, github_synced_at = now(), updated_at = now() WHERE id = $1", [m.space.id, input.org]);
  await audit(m.space.id, user.id, "github.imported", { org: input.org, repos: input.repos });
  await announce(m.space.id, "updated");
  return c.json({ ok: true });
});

workspaces.delete("/workspaces/:id", async (c) => {
  const user = c.get("user");
  const m = await membership(user.id, c.req.param("id"), "owner");
  if (m.space.kind !== "workspace") throw badRequest("Your personal space can't be deleted.");
  const ids = await memberIds(m.space.id);
  await query("UPDATE kern_space SET deleted_at = now(), slug = NULL WHERE id = $1", [m.space.id]);
  await audit(m.space.id, user.id, "workspace.deleted");
  for (const id of ids) notifyUser(id, { type: "space", event: "deleted", space: m.space.id });
  evict(m.space.id);
  return c.json({ ok: true });
});

workspaces.post("/workspaces/:id/leave", async (c) => {
  const user = c.get("user");
  const m = await membership(user.id, c.req.param("id"));
  if (m.role === "owner") throw conflict("Transfer ownership to someone else before leaving.", "owner");
  await query("DELETE FROM kern_member WHERE space_id = $1 AND user_id = $2", [m.space.id, user.id]);
  await audit(m.space.id, user.id, "member.left");
  evict(m.space.id, user.id);
  await announce(m.space.id, "members");
  return c.json({ ok: true });
});

workspaces.post("/workspaces/:id/transfer", async (c) => {
  const user = c.get("user");
  const input = await body(c, z.object({ userId: z.string().min(1) }));
  await tx(async (db) => {
    const m = await membership(user.id, c.req.param("id"), "owner", db);
    const target = await one<{ role: Role }>("SELECT role FROM kern_member WHERE space_id = $1 AND user_id = $2", [m.space.id, input.userId], db);
    if (!target) throw notFound("Member");
    await query("UPDATE kern_member SET role = 'owner' WHERE space_id = $1 AND user_id = $2", [m.space.id, input.userId], db);
    await query("UPDATE kern_member SET role = 'admin' WHERE space_id = $1 AND user_id = $2", [m.space.id, user.id], db);
    await query("UPDATE kern_space SET owner_id = $2, updated_at = now() WHERE id = $1", [m.space.id, input.userId], db);
    await audit(m.space.id, user.id, "workspace.transferred", { to: input.userId }, db);
  });
  await announce(c.req.param("id"), "members");
  return c.json({ ok: true });
});

// ------------------------------------------------------------ members

workspaces.get("/workspaces/:id/members", async (c) => {
  const m = await membership(c.get("user").id, c.req.param("id"));
  return c.json(await members(m.space.id));
});

workspaces.patch("/workspaces/:id/members/:userId", async (c) => {
  const user = c.get("user");
  const input = await body(c, z.object({ role: z.enum(["admin", "member", "viewer"]).optional(), title: z.string().trim().max(60).nullable().optional() }));
  const targetId = c.req.param("userId");
  await tx(async (db) => {
    const self = targetId === user.id;
    // Anyone may set their own title; roles need an admin.
    const m = await membership(user.id, c.req.param("id"), self && input.role === undefined ? "viewer" : "admin", db);
    const target = await one<{ role: Role }>("SELECT role FROM kern_member WHERE space_id = $1 AND user_id = $2", [m.space.id, targetId], db);
    if (!target) throw notFound("Member");
    if (input.role !== undefined) {
      if (target.role === "owner") throw forbidden("The owner's role can't be changed. Transfer ownership instead.");
      if (m.role === "admin" && target.role === "admin" && !self) throw forbidden("Only the owner can change another admin's role.");
      await query("UPDATE kern_member SET role = $3 WHERE space_id = $1 AND user_id = $2", [m.space.id, targetId, input.role], db);
      await audit(m.space.id, user.id, "member.role", { userId: targetId, role: input.role }, db);
    }
    if (input.title !== undefined) await query("UPDATE kern_member SET title = $3 WHERE space_id = $1 AND user_id = $2", [m.space.id, targetId, input.title || null], db);
  });
  await announce(c.req.param("id"), "members");
  return c.json({ ok: true });
});

workspaces.delete("/workspaces/:id/members/:userId", async (c) => {
  const user = c.get("user");
  const targetId = c.req.param("userId");
  const m = await membership(user.id, c.req.param("id"), "admin");
  const target = await one<{ role: Role }>("SELECT role FROM kern_member WHERE space_id = $1 AND user_id = $2", [m.space.id, targetId]);
  if (!target) throw notFound("Member");
  if (target.role === "owner") throw forbidden("The owner can't be removed.");
  if (m.role === "admin" && target.role === "admin" && targetId !== user.id) throw forbidden("Only the owner can remove an admin.");
  await query("DELETE FROM kern_member WHERE space_id = $1 AND user_id = $2", [m.space.id, targetId]);
  await audit(m.space.id, user.id, "member.removed", { userId: targetId });
  notifyUser(targetId, { type: "space", event: "removed", space: m.space.id });
  evict(m.space.id, targetId);
  await announce(m.space.id, "members");
  return c.json({ ok: true });
});

// ------------------------------------------------------------ invitations (admin)

workspaces.post("/workspaces/:id/invites", async (c) => {
  const user = c.get("user");
  requireVerified(user);
  const input = await body(c, z.object({ invites: z.array(inviteInput).min(1).max(50), message: z.string().trim().max(500).optional() }));
  const m = await membership(user.id, c.req.param("id"), "admin");
  if (m.space.kind !== "workspace") throw badRequest("Personal spaces can't be shared. Create a workspace instead.");
  const results = await createInvites(m.space, user, input.invites, input.message ?? null);
  return c.json({ results });
});

workspaces.post("/workspaces/:id/invites/:inviteId/resend", async (c) => {
  const user = c.get("user");
  const m = await membership(user.id, c.req.param("id"), "admin");
  const inv = await one<InviteRow>("SELECT * FROM kern_invite WHERE id = $1 AND space_id = $2", [c.req.param("inviteId"), m.space.id]);
  if (!inv || inv.accepted_at || inv.revoked_at) throw notFound("Invitation");
  if (inv.last_sent_at && Date.now() - inv.last_sent_at.getTime() < 60_000) throw new HttpError(429, "rate_limited", "Wait a minute before sending this invitation again.");
  const results = await createInvites(m.space, user, [{ email: inv.email, role: inv.role }], inv.message);
  return c.json(results[0]);
});

workspaces.delete("/workspaces/:id/invites/:inviteId", async (c) => {
  const user = c.get("user");
  const m = await membership(user.id, c.req.param("id"), "admin");
  await query("UPDATE kern_invite SET revoked_at = now() WHERE id = $1 AND space_id = $2 AND accepted_at IS NULL", [c.req.param("inviteId"), m.space.id]);
  await audit(m.space.id, user.id, "invite.revoked", { invite: c.req.param("inviteId") });
  return c.json({ ok: true });
});

workspaces.get("/workspaces/:id/activity", async (c) => {
  const m = await membership(c.get("user").id, c.req.param("id"), "admin");
  const rows = await query<{ id: number; action: string; detail: unknown; created_at: Date; actor_name: string | null }>(
    `SELECT a.id, a.action, a.detail, a.created_at, u.name AS actor_name FROM kern_audit a LEFT JOIN "user" u ON u.id = a.actor_id
     WHERE a.space_id = $1 ORDER BY a.created_at DESC LIMIT 100`,
    [m.space.id],
  );
  return c.json(rows.map((r) => ({ id: r.id, action: r.action, detail: r.detail, at: iso(r.created_at), actor: r.actor_name })));
});

// ------------------------------------------------------------ invitations (invitee)

/** Accepting needs a session whose verified email matches the invitation. */
workspaces.post("/invites/:id/accept", async (c) => {
  const user = c.get("user");
  requireVerified(user);
  const id = c.req.param("id");
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("Invitation");
  const space = await tx(async (db) => {
    const inv = await one<InviteRow>("SELECT * FROM kern_invite WHERE id = $1 FOR UPDATE", [id], db);
    if (!inv) throw notFound("Invitation");
    const status = inviteStatus(inv);
    if (status === "accepted") {
      const mine = await one("SELECT 1 FROM kern_member WHERE space_id = $1 AND user_id = $2", [inv.space_id, user.id], db);
      if (!mine) throw new HttpError(410, "used", "This invitation has already been used.");
    } else if (status !== "pending") {
      throw new HttpError(410, status, status === "expired" ? "This invitation has expired. Ask for a new one." : "This invitation is no longer valid.");
    }
    if (inv.email.toLowerCase() !== user.email.toLowerCase()) {
      throw forbidden(`This invitation was sent to ${inv.email}. Sign in with that address to accept it.`);
    }
    const s = await one<SpaceRow>("SELECT * FROM kern_space WHERE id = $1 AND deleted_at IS NULL", [inv.space_id], db);
    if (!s) throw new HttpError(410, "deleted", "That workspace no longer exists.");
    await query(
      "INSERT INTO kern_member(space_id, user_id, role, invited_by) VALUES ($1, $2, $3, $4) ON CONFLICT (space_id, user_id) DO NOTHING",
      [s.id, user.id, inv.role, inv.invited_by],
      db,
    );
    await query("UPDATE kern_invite SET accepted_at = coalesce(accepted_at, now()), accepted_by = $2 WHERE id = $1", [id, user.id], db);
    await audit(s.id, user.id, "member.joined", { role: inv.role }, db);
    const role = (await one<{ role: Role }>("SELECT role FROM kern_member WHERE space_id = $1 AND user_id = $2", [s.id, user.id], db))!.role;
    return serializeSpace(s, role);
  });
  await announce(space.id, "members");
  broadcastSpace(space.id, { type: "space", event: "members", space: space.id });
  return c.json(space);
});

workspaces.post("/invites/:id/decline", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("Invitation");
  await query(
    "UPDATE kern_invite SET declined_at = now() WHERE id = $1 AND lower(email) = lower($2) AND accepted_at IS NULL AND revoked_at IS NULL",
    [id, user.email],
  );
  return c.json({ ok: true });
});

/** Public summary of an invitation (shown before signing in). */
export async function inviteSummary(id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const r = await one<InviteRow & { space_name: string; space_logo: string | null; space_deleted: Date | null; inviter_name: string | null }>(
    `SELECT i.*, s.name AS space_name, s.logo AS space_logo, s.deleted_at AS space_deleted, u.name AS inviter_name
     FROM kern_invite i JOIN kern_space s ON s.id = i.space_id LEFT JOIN "user" u ON u.id = i.invited_by WHERE i.id = $1`,
    [id],
  );
  if (!r) return null;
  const [local, domain] = r.email.split("@");
  const masked = `${local!.slice(0, 2)}${"•".repeat(Math.max(1, local!.length - 2))}@${domain}`;
  return {
    id: r.id,
    workspace: r.space_name,
    logo: r.space_logo,
    inviterName: r.inviter_name,
    role: r.role,
    emailHint: masked,
    expiresAt: iso(r.expires_at),
    status: r.space_deleted ? ("revoked" as const) : inviteStatus(r),
  };
}
