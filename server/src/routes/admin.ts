// The management API: /kern/v1/admin/*
//
// One surface, two clients. Kern Platform (the desktop app) and kernctl (the
// headless CLI) both speak only this, so anything one can do the other can
// too, and a server with no graphical session is not a lesser citizen.
//
// Three rules hold throughout:
//
//   - Nothing here reads anybody's work. The management API counts records,
//     measures spaces and lists who belongs to what; it never returns the
//     contents of a task, note or whiteboard. An administrator keeps a server
//     running without reading what people put in it, and a leaked management
//     token must not be a way to read the data either.
//   - Destructive actions name what they will destroy. Deleting an account or
//     purging a workspace takes the name as confirmation in the body, so a
//     mistyped id can't take out the wrong one.
//   - Everything that changes something is recorded in kern_admin_audit with
//     the token that did it.
//
// Reaching it at all is governed by admin/guard.ts: loopback only, unless an
// administrator has deliberately opened it up.

import { Hono, type Context } from "hono";
import { z } from "zod";
import { config } from "../config.js";
import { one, pool, query } from "../db.js";
import { badRequest, body, conflict, HttpError, iso, notFound } from "../lib/http.js";
import { LIVE_KEYS, live, liveWithSource, setLive } from "../live.js";
import { adminAudit, requireAdmin, requireWrite, type AdminEnv } from "../admin/guard.js";
import { fixableIds, runAllFixes, runChecks, runFix } from "../admin/checks.js";
import { tail, type Level } from "../admin/log.js";
import { activity, apiUrl, instanceVersion, overview } from "../admin/stats.js";
import { listTokens, mint, revoke } from "../admin/tokens.js";
import { keyCounts, listKeys, mintKey, revokeKey } from "../workspace-keys.js";
import { broadcastAll, disconnectUser, evict, notifyUser } from "../realtime.js";

/** Realtime statistics, handed in so this module doesn't reach into the server. */
let stats: () => Record<string, unknown> = () => ({});
export function setAdminStats(fn: () => Record<string, unknown>) {
  stats = fn;
}

export const admin = new Hono<AdminEnv>();

admin.use("*", requireAdmin);

const page = z.object({ limit: z.coerce.number().int().min(1).max(500).default(50), offset: z.coerce.number().int().min(0).default(0) });

function paging(c: { req: { query: (k: string) => string | undefined } }) {
  const parsed = page.safeParse({ limit: c.req.query("limit"), offset: c.req.query("offset") });
  if (!parsed.success) throw badRequest("limit and offset must be numbers.");
  return parsed.data;
}

/**
 * The email or name an administrator typed, to confirm a destructive action.
 *
 * Taken from `?confirm=` or from a JSON body, because this guards DELETE
 * routes and a DELETE with a required body is a client-by-client lottery -
 * plenty of HTTP libraries won't send one at all. Either way the server
 * insists on the name, so a mistyped id can't take out the wrong thing.
 */
async function confirmed(c: Context, expected: string, what: string): Promise<void> {
  let given = c.req.query("confirm");
  if (given === undefined) {
    const raw = await c.req.json().catch(() => null);
    const value = (raw as { confirm?: unknown } | null)?.confirm;
    if (typeof value === "string") given = value;
  }
  if ((given ?? "").trim().toLowerCase() !== expected.trim().toLowerCase()) {
    throw badRequest(`To confirm, repeat with ?confirm=${encodeURIComponent(expected)} - the ${what} you mean to remove.`, "confirm_required");
  }
}

// ----------------------------------------------------------------- identity

/** Cheap liveness, and what the token is allowed to do. kernctl calls it first. */
admin.get("/ping", (c) =>
  c.json({
    ok: true,
    instance: live.instanceName,
    version: instanceVersion(),
    apiUrl: apiUrl(),
    token: { id: c.get("admin").id, name: c.get("admin").name, scope: c.get("admin").scope },
    time: new Date().toISOString(),
  }),
);

admin.get("/overview", async (c) => c.json(await overview(stats())));

admin.get("/activity", async (c) => {
  const days = Number.parseInt(c.req.query("days") ?? "30", 10);
  return c.json({ days: Number.isFinite(days) ? days : 30, series: await activity(Number.isFinite(days) ? days : 30) });
});

// ------------------------------------------------------------------- health

admin.get("/health", async (c) => {
  const checks = await runChecks();
  const worst = checks.some((x) => x.status === "fail") ? "fail" : checks.some((x) => x.status === "warn") ? "warn" : "ok";
  return c.json({ status: worst, checks, fixable: fixableIds() });
});

admin.post("/health/fix", async (c) => {
  requireWrite(c.get("admin"));
  const input = await body(c, z.object({ id: z.string().max(64).optional(), all: z.boolean().optional() }));
  if (!input.id && !input.all) throw badRequest('Send either { "id": "<check>" } or { "all": true }.');
  if (input.all) {
    const results = await runAllFixes();
    await adminAudit(c, "health.fix.all", null, { results: results.length });
    return c.json({ results });
  }
  if (!fixableIds().includes(input.id!)) throw notFound(`A repair for "${input.id}"`);
  try {
    const result = await runFix(input.id!);
    await adminAudit(c, "health.fix", input.id!, { done: result.done });
    return c.json({ results: [result] });
  } catch (e) {
    throw new HttpError(500, "fix_failed", `That repair didn't finish: ${(e as Error).message}`);
  }
});

// ----------------------------------------------------------------- settings

admin.get("/settings", (c) =>
  c.json({
    // Changeable from here.
    settings: liveWithSource(),
    // Read-only: these come from the environment and need a restart.
    environment: {
      publicUrl: config.publicUrl,
      linkUrl: config.linkUrl,
      streamsUrl: config.streamsUrl,
      apiUrl: apiUrl(),
      appScheme: config.appScheme,
      port: config.port,
      host: config.host,
      mail: { configured: !config.mailToConsole, host: config.mail.host, port: config.mail.port, from: config.mail.from },
      inboundEmail: { enabled: !!config.inboundEmail.secret, domain: config.inboundEmail.domain },
      admin: { localOnly: config.admin.localOnly, allowFrom: config.admin.allowFrom, tokenFile: config.admin.tokenFile || null },
      limits: config.limits,
      inviteDays: config.inviteDays,
      streamsKeySet: !!config.streamsKey,
    },
    keys: LIVE_KEYS,
  }),
);

admin.patch("/settings", async (c) => {
  requireWrite(c.get("admin"));
  const raw = await body(c, z.record(z.string(), z.unknown()));
  const unknown = Object.keys(raw).filter((k) => !LIVE_KEYS.includes(k as (typeof LIVE_KEYS)[number]));
  if (unknown.length) throw badRequest(`Not a changeable setting: ${unknown.join(", ")}. Changeable: ${LIVE_KEYS.join(", ")}.`);
  const written = await setLive(raw);
  await adminAudit(c, "settings.update", null, { keys: written });
  return c.json({ settings: liveWithSource(), changed: written });
});

// -------------------------------------------------------------------- users

interface UserRow {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  createdAt: Date;
  held: boolean;
  hold_reason: string | null;
  spaces: string;
  sessions: string;
  records: string;
}

const serializeUser = (u: UserRow) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  emailVerified: u.emailVerified,
  hasImage: !!u.image,
  createdAt: iso(u.createdAt),
  held: u.held,
  holdReason: u.hold_reason,
  spaces: Number(u.spaces),
  activeSessions: Number(u.sessions),
  records: Number(u.records),
});

admin.get("/users", async (c) => {
  const { limit, offset } = paging(c);
  const q = (c.req.query("q") ?? "").trim().toLowerCase();
  const filter = c.req.query("filter") ?? "";
  const where: string[] = [];
  const params: unknown[] = [];
  if (q) {
    params.push(`%${q}%`);
    where.push(`(lower(u.email) LIKE $${params.length} OR lower(u.name) LIKE $${params.length})`);
  }
  if (filter === "held") where.push("h.user_id IS NOT NULL");
  else if (filter === "unverified") where.push(`u."emailVerified" = false`);
  params.push(limit, offset);
  const rows = await query<UserRow>(
    `SELECT u.id, u.name, u.email, u."emailVerified", u.image, u."createdAt",
            h.user_id IS NOT NULL AS held, h.reason AS hold_reason,
            (SELECT count(*) FROM kern_member m WHERE m.user_id = u.id) AS spaces,
            (SELECT count(*) FROM "session" s WHERE s."userId" = u.id AND s."expiresAt" > now()) AS sessions,
            (SELECT count(*) FROM kern_record r JOIN kern_space sp ON sp.id = r.space_id WHERE sp.owner_id = u.id) AS records
     FROM "user" u LEFT JOIN kern_account_hold h ON h.user_id = u.id
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY u."createdAt" DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const total = await one<{ n: string }>(`SELECT count(*) AS n FROM "user"`);
  return c.json({ users: rows.map(serializeUser), total: Number(total?.n ?? 0), limit, offset });
});

async function loadUser(id: string): Promise<UserRow> {
  const row = await one<UserRow>(
    `SELECT u.id, u.name, u.email, u."emailVerified", u.image, u."createdAt",
            h.user_id IS NOT NULL AS held, h.reason AS hold_reason,
            (SELECT count(*) FROM kern_member m WHERE m.user_id = u.id) AS spaces,
            (SELECT count(*) FROM "session" s WHERE s."userId" = u.id AND s."expiresAt" > now()) AS sessions,
            (SELECT count(*) FROM kern_record r JOIN kern_space sp ON sp.id = r.space_id WHERE sp.owner_id = u.id) AS records
     FROM "user" u LEFT JOIN kern_account_hold h ON h.user_id = u.id WHERE u.id = $1`,
    [id],
  );
  if (!row) throw notFound("That account");
  return row;
}

admin.get("/users/:id", async (c) => {
  const user = await loadUser(c.req.param("id"));
  const spaces = await query<{ id: string; kind: string; name: string; role: string; members: string; records: string }>(
    `SELECT s.id, s.kind, s.name, m.role,
            (SELECT count(*) FROM kern_member x WHERE x.space_id = s.id) AS members,
            (SELECT count(*) FROM kern_record r WHERE r.space_id = s.id) AS records
     FROM kern_member m JOIN kern_space s ON s.id = m.space_id
     WHERE m.user_id = $1 AND s.deleted_at IS NULL ORDER BY s.kind, s.name`,
    [user.id],
  );
  const sessions = await query<{ id: string; createdAt: Date; expiresAt: Date; ipAddress: string | null; userAgent: string | null }>(
    `SELECT id, "createdAt", "expiresAt", "ipAddress", "userAgent" FROM "session" WHERE "userId" = $1 AND "expiresAt" > now() ORDER BY "createdAt" DESC LIMIT 25`,
    [user.id],
  );
  return c.json({
    user: serializeUser(user),
    spaces: spaces.map((s) => ({ id: s.id, kind: s.kind, name: s.name, role: s.role, members: Number(s.members), records: Number(s.records) })),
    sessions: sessions.map((s) => ({
      id: s.id,
      createdAt: iso(s.createdAt),
      expiresAt: iso(s.expiresAt),
      ip: s.ipAddress,
      // Trimmed: enough to recognise a device, not a fingerprint to keep.
      client: (s.userAgent ?? "").slice(0, 120) || null,
    })),
  });
});

admin.post("/users/:id/hold", async (c) => {
  requireWrite(c.get("admin"));
  const user = await loadUser(c.req.param("id"));
  const input = await body(c, z.object({ reason: z.string().trim().max(200).default("") }));
  await query(
    `INSERT INTO kern_account_hold(user_id, reason, created_by) VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET reason = excluded.reason, created_at = now(), created_by = excluded.created_by`,
    [user.id, input.reason, c.get("admin").id],
  );
  // Suspending has to take effect now, not when the session happens to expire.
  await query(`DELETE FROM "session" WHERE "userId" = $1`, [user.id]);
  disconnectUser(user.id, "Your account has been suspended on this server.");
  await adminAudit(c, "user.hold", user.id, { email: user.email, reason: input.reason });
  return c.json({ user: serializeUser(await loadUser(user.id)) });
});

admin.delete("/users/:id/hold", async (c) => {
  requireWrite(c.get("admin"));
  const user = await loadUser(c.req.param("id"));
  await query("DELETE FROM kern_account_hold WHERE user_id = $1", [user.id]);
  await adminAudit(c, "user.release", user.id, { email: user.email });
  return c.json({ user: serializeUser(await loadUser(user.id)) });
});

admin.post("/users/:id/verify", async (c) => {
  requireWrite(c.get("admin"));
  const user = await loadUser(c.req.param("id"));
  if (user.emailVerified) return c.json({ user: serializeUser(user) });
  await query(`UPDATE "user" SET "emailVerified" = true, "updatedAt" = now() WHERE id = $1`, [user.id]);
  await adminAudit(c, "user.verify", user.id, { email: user.email });
  return c.json({ user: serializeUser(await loadUser(user.id)) });
});

admin.post("/users/:id/sessions/revoke", async (c) => {
  requireWrite(c.get("admin"));
  const user = await loadUser(c.req.param("id"));
  const rows = await query(`DELETE FROM "session" WHERE "userId" = $1 RETURNING id`, [user.id]);
  disconnectUser(user.id, "Your sessions were ended by this server's administrator. Sign in again.");
  await adminAudit(c, "user.sessions.revoke", user.id, { email: user.email, sessions: rows.length });
  return c.json({ revoked: rows.length });
});

admin.delete("/users/:id", async (c) => {
  requireWrite(c.get("admin"));
  const user = await loadUser(c.req.param("id"));
  await confirmed(c, user.email, "email address");
  // Workspaces they own go with them; warn rather than silently take other
  // people's work with it.
  const shared = await query<{ name: string; members: string }>(
    `SELECT s.name, (SELECT count(*) FROM kern_member m WHERE m.space_id = s.id) AS members
     FROM kern_space s WHERE s.owner_id = $1 AND s.kind = 'workspace' AND s.deleted_at IS NULL
       AND (SELECT count(*) FROM kern_member m WHERE m.space_id = s.id) > 1`,
    [user.id],
  );
  if (shared.length && !c.req.query("withWorkspaces")) {
    throw conflict(
      `That account owns ${shared.length} workspace${shared.length === 1 ? "" : "s"} other people still use (${shared.map((s) => s.name).join(", ")}). Transfer them first, or repeat with ?withWorkspaces=true to delete them too.`,
      "owns_shared_workspaces",
    );
  }
  const spaces = await query<{ id: string }>("SELECT id FROM kern_space WHERE owner_id = $1", [user.id]);
  // The row cascades into spaces, membership, records, assets and streams.
  await query(`DELETE FROM "user" WHERE id = $1`, [user.id]);
  for (const s of spaces) evict(s.id);
  disconnectUser(user.id, "This account has been removed from the server.");
  await adminAudit(c, "user.delete", user.id, { email: user.email, spaces: spaces.length });
  return c.json({ deleted: true, email: user.email, spacesRemoved: spaces.length });
});

// ------------------------------------------------------- sign-up allow list

admin.get("/allow", async (c) => {
  const rows = await query<{ email: string; note: string; created_at: Date; used_at: Date | null }>(
    "SELECT email, note, created_at, used_at FROM kern_signup_allow ORDER BY created_at DESC LIMIT 500",
  );
  return c.json({
    registration: live.registration,
    allowed: rows.map((r) => ({ email: r.email, note: r.note, createdAt: iso(r.created_at), usedAt: iso(r.used_at) })),
  });
});

admin.post("/allow", async (c) => {
  requireWrite(c.get("admin"));
  const input = await body(c, z.object({ email: z.email().max(254), note: z.string().trim().max(200).default("") }));
  const email = input.email.toLowerCase();
  await query(
    `INSERT INTO kern_signup_allow(email, note, created_by) VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE SET note = excluded.note, created_at = now()`,
    [email, input.note, c.get("admin").id],
  );
  await adminAudit(c, "allow.add", email, { note: input.note });
  return c.json({ email, registration: live.registration }, 201);
});

admin.delete("/allow/:email", async (c) => {
  requireWrite(c.get("admin"));
  const email = decodeURIComponent(c.req.param("email")).toLowerCase();
  const rows = await query("DELETE FROM kern_signup_allow WHERE email = $1 RETURNING email", [email]);
  if (!rows.length) throw notFound("That address");
  await adminAudit(c, "allow.remove", email);
  return c.json({ removed: email });
});

// ------------------------------------------------------------------- spaces

admin.get("/spaces", async (c) => {
  const { limit, offset } = paging(c);
  const q = (c.req.query("q") ?? "").trim().toLowerCase();
  const kind = c.req.query("kind");
  const where = ["(s.deleted_at IS NULL OR $1::boolean)"];
  const params: unknown[] = [c.req.query("deleted") === "true"];
  if (q) {
    params.push(`%${q}%`);
    where.push(`lower(s.name) LIKE $${params.length}`);
  }
  if (kind === "personal" || kind === "workspace") {
    params.push(kind);
    where.push(`s.kind = $${params.length}`);
  }
  params.push(limit, offset);
  const rows = await query<{
    id: string;
    kind: string;
    name: string;
    owner: string;
    owner_id: string;
    members: string;
    records: string;
    tombstones: string;
    assets: string;
    asset_bytes: string;
    streams: string;
    seq: string;
    created_at: Date;
    updated_at: Date;
    deleted_at: Date | null;
  }>(
    `SELECT s.id, s.kind, s.name, s.owner_id, u.email AS owner, s.seq, s.created_at, s.updated_at, s.deleted_at,
            (SELECT count(*) FROM kern_member m WHERE m.space_id = s.id) AS members,
            (SELECT count(*) FROM kern_record r WHERE r.space_id = s.id AND NOT r.deleted) AS records,
            (SELECT count(*) FROM kern_record r WHERE r.space_id = s.id AND r.deleted) AS tombstones,
            (SELECT count(*) FROM kern_asset a WHERE a.space_id = s.id) AS assets,
            (SELECT coalesce(sum(a.size), 0)::text FROM kern_asset a WHERE a.space_id = s.id) AS asset_bytes,
            (SELECT count(*) FROM kern_stream st WHERE st.space_id = s.id) AS streams
     FROM kern_space s JOIN "user" u ON u.id = s.owner_id
     WHERE ${where.join(" AND ")}
     ORDER BY s.updated_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return c.json({
    spaces: rows.map((s) => ({
      id: s.id,
      kind: s.kind,
      name: s.name,
      owner: { id: s.owner_id, email: s.owner },
      members: Number(s.members),
      records: Number(s.records),
      tombstones: Number(s.tombstones),
      assets: Number(s.assets),
      assetBytes: Number(s.asset_bytes),
      streams: Number(s.streams),
      head: Number(s.seq),
      createdAt: iso(s.created_at),
      updatedAt: iso(s.updated_at),
      deletedAt: iso(s.deleted_at),
    })),
    limit,
    offset,
  });
});

admin.get("/spaces/:id", async (c) => {
  const id = c.req.param("id");
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("That space");
  const space = await one<{ id: string; kind: string; name: string; owner_id: string; seq: string; created_at: Date; deleted_at: Date | null }>(
    "SELECT id, kind, name, owner_id, seq, created_at, deleted_at FROM kern_space WHERE id = $1",
    [id],
  );
  if (!space) throw notFound("That space");
  const members = await query<{ user_id: string; email: string; name: string; role: string; joined_at: Date }>(
    `SELECT m.user_id, u.email, u.name, m.role, m.joined_at FROM kern_member m JOIN "user" u ON u.id = m.user_id
     WHERE m.space_id = $1 ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 ELSE 3 END, u.email`,
    [id],
  );
  // Row counts per table: how big a space is, with nothing of what's in it.
  const tables = await query<{ tbl: string; n: string; deleted: string }>(
    "SELECT tbl, count(*) FILTER (WHERE NOT deleted) AS n, count(*) FILTER (WHERE deleted) AS deleted FROM kern_record WHERE space_id = $1 GROUP BY tbl ORDER BY 2 DESC",
    [id],
  );
  return c.json({
    space: {
      id: space.id,
      kind: space.kind,
      name: space.name,
      ownerId: space.owner_id,
      head: Number(space.seq),
      createdAt: iso(space.created_at),
      deletedAt: iso(space.deleted_at),
    },
    members: members.map((m) => ({ id: m.user_id, email: m.email, name: m.name, role: m.role, joinedAt: iso(m.joined_at) })),
    tables: tables.map((t) => ({ table: t.tbl, records: Number(t.n), tombstones: Number(t.deleted) })),
  });
});

admin.delete("/spaces/:id", async (c) => {
  requireWrite(c.get("admin"));
  const id = c.req.param("id");
  const space = await one<{ id: string; name: string; kind: string; deleted_at: Date | null }>("SELECT id, name, kind, deleted_at FROM kern_space WHERE id = $1", [id]);
  if (!space) throw notFound("That space");
  if (space.kind === "personal") throw badRequest("A personal space belongs to its account; delete the account instead.", "personal_space");
  await confirmed(c, space.name, "workspace name");
  const purge = c.req.query("purge") === "true";
  if (purge) {
    await query("DELETE FROM kern_space WHERE id = $1", [id]);
  } else {
    await query("UPDATE kern_space SET deleted_at = now(), updated_at = now() WHERE id = $1 AND deleted_at IS NULL", [id]);
  }
  // Tell anyone with it open, before their subscription goes away.
  evict(id);
  await adminAudit(c, purge ? "space.purge" : "space.delete", id, { name: space.name });
  return c.json({ id, name: space.name, purged: purge });
});

// ------------------------------------------------------------------ invites

admin.get("/invites", async (c) => {
  const { limit, offset } = paging(c);
  const rows = await query<{ id: string; email: string; role: string; space: string; space_id: string; created_at: Date; expires_at: Date; accepted_at: Date | null; revoked_at: Date | null; declined_at: Date | null }>(
    `SELECT i.id, i.email, i.role, s.name AS space, i.space_id, i.created_at, i.expires_at, i.accepted_at, i.revoked_at, i.declined_at
     FROM kern_invite i JOIN kern_space s ON s.id = i.space_id
     ORDER BY i.created_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  const state = (r: (typeof rows)[number]) =>
    r.accepted_at ? "accepted" : r.revoked_at ? "revoked" : r.declined_at ? "declined" : r.expires_at.getTime() < Date.now() ? "expired" : "pending";
  return c.json({
    invites: rows.map((r) => ({
      id: r.id,
      email: r.email,
      role: r.role,
      workspace: { id: r.space_id, name: r.space },
      status: state(r),
      createdAt: iso(r.created_at),
      expiresAt: iso(r.expires_at),
    })),
    limit,
    offset,
  });
});

admin.delete("/invites/:id", async (c) => {
  requireWrite(c.get("admin"));
  const rows = await query<{ id: string; email: string }>(
    "UPDATE kern_invite SET revoked_at = now() WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id, email",
    [c.req.param("id")],
  );
  if (!rows.length) throw notFound("An open invitation with that id");
  await adminAudit(c, "invite.revoke", rows[0]!.id, { email: rows[0]!.email });
  return c.json({ revoked: rows[0]!.id });
});

// ------------------------------------------------------------------ streams

admin.get("/streams", async (c) => {
  const { limit, offset } = paging(c);
  const rows = await query<{
    id: string;
    name: string;
    enabled: boolean;
    space: string;
    space_id: string;
    deliveries: string;
    last_delivery_at: Date | null;
    failures: string;
    created_at: Date;
  }>(
    `SELECT st.id, st.name, st.enabled, s.name AS space, st.space_id, st.delivery_count AS deliveries, st.last_delivery_at, st.created_at,
            (SELECT count(*) FROM kern_stream_event e WHERE e.stream_id = st.id AND e.status IN ('failed', 'rejected') AND e.received_at > now() - interval '7 days') AS failures
     FROM kern_stream st JOIN kern_space s ON s.id = st.space_id
     ORDER BY st.last_delivery_at DESC NULLS LAST LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return c.json({
    streams: rows.map((r) => ({
      // The id is also the endpoint path, so it is a secret in its own right:
      // show enough to recognise a stream, not enough to post to it.
      id: `${r.id.slice(0, 8)}…${r.id.slice(-4)}`,
      fullId: r.id,
      name: r.name,
      enabled: r.enabled,
      workspace: { id: r.space_id, name: r.space },
      deliveries: Number(r.deliveries),
      failuresThisWeek: Number(r.failures),
      lastDeliveryAt: iso(r.last_delivery_at),
      createdAt: iso(r.created_at),
    })),
    limit,
    offset,
  });
});

admin.patch("/streams/:id", async (c) => {
  requireWrite(c.get("admin"));
  const id = c.req.param("id");
  if (!/^[0-9a-f]{64}$/.test(id)) throw notFound("That stream");
  const input = await body(c, z.object({ enabled: z.boolean() }));
  const rows = await query<{ id: string; name: string }>("UPDATE kern_stream SET enabled = $2, updated_at = now() WHERE id = $1 RETURNING id, name", [id, input.enabled]);
  if (!rows.length) throw notFound("That stream");
  await adminAudit(c, input.enabled ? "stream.enable" : "stream.disable", id, { name: rows[0]!.name });
  return c.json({ id, enabled: input.enabled });
});

// ------------------------------------------------------------------- tokens

// ---- workspace keys -------------------------------------------------------
//
// Only meaningful while WORKSPACE_KEYS is "required", but they can be minted
// before turning it on, so an administrator can hand keys out first and switch
// the gate on once people have them.

admin.get("/workspace-keys", async (c) => {
  const [rows, counts] = await Promise.all([listKeys(), keyCounts()]);
  return c.json({
    required: live.workspaceKeys === "required",
    counts,
    keys: rows.map((k) => ({
      id: k.id,
      note: k.note,
      createdAt: iso(k.created_at),
      redeemedBy: k.redeemed_by,
      redeemedEmail: k.redeemed_email,
      redeemedAt: iso(k.redeemed_at),
      lastUsedAt: iso(k.last_used_at),
      uses: k.uses,
      revokedAt: iso(k.revoked_at),
    })),
  });
});

admin.post("/workspace-keys", async (c) => {
  requireWrite(c.get("admin"));
  const input = await body(c, z.object({ note: z.string().trim().max(120).default("") }));
  const minted = await mintKey({ note: input.note, createdBy: c.get("admin").id });
  await adminAudit(c, "workspace-key.create", minted.id, { note: minted.note });
  // The only time the key itself is ever returned.
  return c.json({ key: minted.key, id: minted.id, note: minted.note }, 201);
});

admin.delete("/workspace-keys/:id", async (c) => {
  requireWrite(c.get("admin"));
  const id = c.req.param("id");
  if (!(await revokeKey(id))) throw notFound("That workspace key");
  await adminAudit(c, "workspace-key.revoke", id, {});
  return c.json({ ok: true });
});

admin.get("/tokens", async (c) => {
  const rows = await listTokens();
  return c.json({
    tokens: rows.map((t) => ({
      id: t.id,
      name: t.name,
      scope: t.scope,
      createdAt: iso(t.created_at),
      lastUsedAt: iso(t.last_used_at),
      lastUsedIp: t.last_used_ip,
      expiresAt: iso(t.expires_at),
      revokedAt: iso(t.revoked_at),
      current: t.id === c.get("admin").id,
    })),
  });
});

admin.post("/tokens", async (c) => {
  requireWrite(c.get("admin"));
  const input = await body(
    c,
    z.object({
      name: z.string().trim().min(1).max(80),
      scope: z.enum(["full", "read"]).default("full"),
      days: z.number().int().min(1).max(3650).nullable().default(null),
    }),
  );
  const minted = await mint({ name: input.name, scope: input.scope, days: input.days, createdBy: c.get("admin").id });
  await adminAudit(c, "token.create", minted.id, { name: minted.name, scope: minted.scope });
  // The only time the token itself is ever returned.
  return c.json({ token: minted.token, id: minted.id, name: minted.name, scope: minted.scope, expiresAt: iso(minted.expiresAt) }, 201);
});

admin.delete("/tokens/:id", async (c) => {
  requireWrite(c.get("admin"));
  const id = c.req.param("id");
  if (id === c.get("admin").id && c.req.query("self") !== "true") {
    throw badRequest("That's the token you're using. Repeat with ?self=true if you mean to lock yourself out.", "revoking_self");
  }
  if (!(await revoke(id))) throw notFound("An active token with that id");
  await adminAudit(c, "token.revoke", id);
  return c.json({ revoked: id });
});

// --------------------------------------------------------------- log, audit

admin.get("/logs", async (c) => {
  const since = Number.parseInt(c.req.query("since") ?? "0", 10);
  const limit = Number.parseInt(c.req.query("limit") ?? "200", 10);
  const level = c.req.query("level");
  return c.json(
    tail({
      since: Number.isFinite(since) ? since : 0,
      limit: Number.isFinite(limit) ? limit : 200,
      level: level === "warn" || level === "error" ? (level as Level) : undefined,
    }),
  );
});

admin.get("/audit", async (c) => {
  const { limit, offset } = paging(c);
  const rows = await query<{ id: string; token_id: string | null; action: string; target: string | null; detail: unknown; ip: string | null; created_at: Date; token_name: string | null }>(
    `SELECT a.id, a.token_id, a.action, a.target, a.detail, a.ip, a.created_at, t.name AS token_name
     FROM kern_admin_audit a LEFT JOIN kern_admin_token t ON t.id = a.token_id
     ORDER BY a.created_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return c.json({
    entries: rows.map((r) => ({
      id: Number(r.id),
      action: r.action,
      target: r.target,
      detail: r.detail,
      by: r.token_name ?? r.token_id,
      ip: r.ip,
      at: iso(r.created_at),
    })),
    limit,
    offset,
  });
});

// ---------------------------------------------------------------- broadcast

admin.post("/notice", async (c) => {
  requireWrite(c.get("admin"));
  const input = await body(
    c,
    z.object({
      message: z.string().trim().min(1).max(300),
      level: z.enum(["info", "warn"]).default("info"),
      userId: z.string().max(64).optional(),
    }),
  );
  const notice = { type: "notice", level: input.level, message: input.message, from: live.instanceName, at: Date.now() };
  if (input.userId) notifyUser(input.userId, notice);
  else broadcastAll(notice);
  await adminAudit(c, "notice", input.userId ?? null, { level: input.level });
  return c.json({ sent: true, to: input.userId ?? "everyone connected" });
});

// --------------------------------------------------------------- SQL window

/**
 * A read-only look at the database, for the questions an administrator asks
 * once and a built-in page never anticipates.
 *
 * It is deliberately narrow: one statement, it must start with SELECT, and it
 * runs in a transaction that is read-only at the database level and rolled
 * back, with a statement timeout. That last part matters most - a clever
 * SELECT can still call a function that writes, and only Postgres itself can
 * refuse that reliably.
 */
admin.post("/query", async (c) => {
  requireWrite(c.get("admin"));
  const input = await body(c, z.object({ sql: z.string().trim().min(1).max(4000), limit: z.number().int().min(1).max(1000).default(200) }));
  const sql = input.sql.replace(/;\s*$/, "");
  if (!/^(select|with)\b/i.test(sql)) throw badRequest("Only SELECT (or WITH … SELECT) statements run here.", "read_only");
  if (sql.includes(";")) throw badRequest("One statement at a time.", "one_statement");
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '10s'");
    const result = await client.query(`SELECT * FROM (${sql}) AS q LIMIT ${input.limit}`);
    await adminAudit(c, "query", null, { rows: result.rowCount });
    return c.json({
      fields: result.fields.map((f) => f.name),
      rows: result.rows,
      rowCount: result.rowCount,
      truncated: (result.rowCount ?? 0) >= input.limit,
    });
  } catch (e) {
    throw badRequest(`The database refused that: ${(e as Error).message}`, "query_failed");
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
});

// ------------------------------------------------------------- housekeeping

/**
 * Everything the hourly housekeeping does, on demand. Useful straight after an
 * import, and the one thing `kernctl heal --quick` runs.
 */
admin.post("/housekeeping", async (c) => {
  requireWrite(c.get("admin"));
  // Not wrapped in a transaction: one of the steps vacuums, which Postgres
  // refuses inside one.
  const results = await runAllFixes();
  await adminAudit(c, "housekeeping", null, { steps: results.length });
  return c.json({ results });
});
