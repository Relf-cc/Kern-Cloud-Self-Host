// Who may reach the management API.
//
// Two gates, in this order:
//
//  1. Where the request came from. By default only loopback, which is what
//     makes "manage it from the same machine, or over an SSH tunnel" the
//     normal way in: nothing on the network can even attempt a token. Opening
//     it up needs ADMIN_LOCAL_ONLY=false and an explicit ADMIN_ALLOW_FROM
//     list, because a management API on a public port is a different risk from
//     a sync API.
//  2. A management token (admin/tokens.ts), as `Authorization: Bearer …`.
//
// The client address comes from the socket, not from a header: a proxy header
// is attacker-controlled, and trusting one here would undo gate 1. Running the
// management API behind a reverse proxy therefore means the proxy itself is on
// the allow list, and you must restrict who can reach it there.

import type { MiddlewareHandler } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { config } from "../config.js";
import { HttpError } from "../lib/http.js";
import { query } from "../db.js";
import { addressAllowed } from "./reach.js";
import { verify, type Scope } from "./tokens.js";

export type AdminEnv = { Variables: { admin: { id: string; name: string; scope: Scope }; adminIp: string | null } };

/** This instance's rule, from the environment. The logic is in reach.ts. */
const allowed = (address: string | null) => addressAllowed(address, config.admin);

/**
 * Requires an allowed address and a valid management token. The token is
 * available as c.get("admin").
 */
export const requireAdmin: MiddlewareHandler<AdminEnv> = async (c, next) => {
  const address = getConnInfo(c).remote.address ?? null;
  if (!allowed(address)) {
    // Say why: an administrator who has just opened a port needs to know it is
    // the address list refusing them, not their token.
    throw new HttpError(
      403,
      "admin_local_only",
      config.admin.localOnly
        ? "The management API only answers the server's own machine. Connect over 127.0.0.1 or an SSH tunnel, or set ADMIN_LOCAL_ONLY=false and list your address in ADMIN_ALLOW_FROM."
        : "That address isn't in ADMIN_ALLOW_FROM.",
    );
  }
  c.set("adminIp", address);
  const header = c.req.header("Authorization") ?? "";
  const presented = header.toLowerCase().startsWith("bearer ") ? header.slice(7) : "";
  const token = presented ? await verify(presented, address) : null;
  if (!token) throw new HttpError(401, "admin_unauthorized", "That management token isn't valid. Run `kernctl token new` on the server to mint one.");
  c.set("admin", token);
  await next();
};

/** Refuses a read-only token. Use on everything that changes something. */
export function requireWrite(admin: { scope: Scope }) {
  if (admin.scope !== "full") throw new HttpError(403, "admin_read_only", "That management token is read-only.");
}

/** Records a management action. Failures are logged, never raised. */
export async function adminAudit(
  c: { get: (k: "admin") => { id: string } | undefined } & { get(k: "adminIp"): string | null },
  action: string,
  target: string | null,
  detail: Record<string, unknown> = {},
): Promise<void> {
  try {
    await query("INSERT INTO kern_admin_audit(token_id, action, target, detail, ip) VALUES ($1, $2, $3, $4, $5)", [
      c.get("admin")?.id ?? null,
      action,
      target,
      JSON.stringify(detail),
      c.get("adminIp"),
    ]);
  } catch (e) {
    console.error("[admin] couldn't record an action", e);
  }
}
