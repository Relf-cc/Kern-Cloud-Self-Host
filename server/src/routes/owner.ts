// /kern/v1/owner/* - managing workspace keys while signed in as yourself.
//
// This exists because of one practical problem. The management API is
// loopback-only by design: it holds the SQL console, account deletion and the
// server's logs, and none of that should be an internet-reachable password
// away. But whoever runs an instance for other people has to hand out
// workspace keys, and doing that over SSH every time is not a life.
//
// So this is a second, deliberately tiny surface:
//
//   - It authenticates with an ordinary account session, like the rest of the
//     app API, so it works through a tunnel or a proxy with no exception
//     carved out for it.
//   - The account must be listed in ADMIN_EMAILS, which lives in the
//     environment rather than the database. Granting it needs shell access on
//     the server, so a compromised database cannot promote anybody.
//   - It can do exactly four things: list keys, mint one, revoke one, and
//     turn the requirement on or off. There is no fifth thing, on purpose.
//     Anything heavier stays on /kern/v1/admin/*, where it needs loopback and
//     a management token.
//
// Every change here is written to the same audit trail as the management API,
// attributed to the account rather than to a token.

import { Hono } from "hono";
import { z } from "zod";
import { config } from "../config.js";
import { query } from "../db.js";
import { body, HttpError, iso, requireUser, type Env } from "../lib/http.js";
import { isListed } from "../lib/owner.js";
import { live, setLive } from "../live.js";
import { keyCounts, listKeys, mintKey, revokeKey } from "../workspace-keys.js";

export const owner = new Hono<Env>();

/** True when this account is one the environment names as an administrator. */
export function isOwner(email: string | null | undefined): boolean {
  return isListed(email, config.adminEmails);
}

owner.use("*", requireUser);

owner.use("*", async (c, next) => {
  const user = c.get("user");
  if (!isOwner(user.email)) {
    // Say nothing about who is an administrator, only that this account is
    // not. The list is configuration, not something to enumerate from here.
    throw new HttpError(403, "not_owner", "That account doesn't manage this server.");
  }
  await next();
});

/** Records an owner action in the management audit trail. */
async function ownerAudit(userId: string, action: string, target: string | null, detail: Record<string, unknown> = {}): Promise<void> {
  try {
    await query("INSERT INTO kern_admin_audit(token_id, action, target, detail, ip) VALUES ($1, $2, $3, $4, $5)", [
      `account:${userId}`,
      action,
      target,
      JSON.stringify(detail),
      null,
    ]);
  } catch (e) {
    console.error("[owner] couldn't record an action", e);
  }
}

/**
 * Who this account is to this server. Kern Platform calls this right after
 * signing in to decide whether to show the keys at all.
 */
owner.get("/me", (c) => {
  const user = c.get("user");
  return c.json({
    instance: live.instanceName,
    apiUrl: `${config.publicUrl}${config.basePath}`,
    owner: true,
    email: user.email,
    workspaceKeys: live.workspaceKeys,
  });
});

owner.get("/workspace-keys", async (c) => {
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

owner.post("/workspace-keys", async (c) => {
  const user = c.get("user");
  const input = await body(c, z.object({ note: z.string().trim().max(120).default("") }));
  const minted = await mintKey({ note: input.note, createdBy: `account:${user.id}` });
  await ownerAudit(user.id, "workspace-key.create", minted.id, { note: minted.note });
  // The only time the key itself is ever returned.
  return c.json({ key: minted.key, id: minted.id, note: minted.note }, 201);
});

owner.delete("/workspace-keys/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  if (!(await revokeKey(id))) throw new HttpError(404, "not_found", "That workspace key wasn't found.");
  await ownerAudit(user.id, "workspace-key.revoke", id, {});
  return c.json({ ok: true });
});

/** Turns the requirement on or off. The one setting this surface may change. */
owner.patch("/workspace-keys", async (c) => {
  const user = c.get("user");
  const input = await body(c, z.object({ required: z.boolean() }));
  await setLive({ workspaceKeys: input.required ? "required" : "off" });
  await ownerAudit(user.id, "settings.update", "workspaceKeys", { workspaceKeys: live.workspaceKeys });
  return c.json({ required: live.workspaceKeys === "required" });
});
