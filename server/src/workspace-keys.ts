// Workspace keys: who may create a workspace on this instance.
//
// A self-hosted server is normally open to whoever has an account on it, and
// that stays the default. But an instance someone runs for other people has a
// different problem: accounts are cheap, and a workspace is what actually
// costs the host storage, mail and attention. `WORKSPACE_KEYS=required` makes
// creating one take a key the administrator minted and handed over. Everyone
// else is told, politely, to run their own server with Kern Platform.
//
// A key reads `k_<32 hex>`. Only its SHA-256 is stored, so the table is
// worthless if it leaks, and the lookup is by hash rather than by comparing
// against every row.
//
// The rules, in one place:
//
//   - The key is needed to CREATE a workspace, nothing else. Accepting an
//     invitation, using a workspace you are already in, and the personal
//     space (which is not a workspace) never consult this.
//   - A key binds to the first account that uses it, and is refused to any
//     other afterwards. That is what stops one key circulating.
//   - Once bound, that account may keep using it, up to WORKSPACES_PER_USER.

import { randomBytes } from "node:crypto";
import { one, query } from "./db.js";
import { fingerprint, looksLikeKey } from "./lib/workspace-key.js";

export { fingerprint, looksLikeKey };

export interface KeyRow {
  id: string;
  note: string;
  created_at: Date;
  created_by: string | null;
  redeemed_by: string | null;
  redeemed_at: Date | null;
  last_used_at: Date | null;
  uses: number;
  revoked_at: Date | null;
}

export interface MintedKey {
  /** The whole key. Never stored, never logged; show it once. */
  key: string;
  id: string;
  note: string;
}

export async function mintKey(opts: { note?: string; createdBy?: string | null } = {}): Promise<MintedKey> {
  const key = `k_${randomBytes(16).toString("hex")}`;
  const { hash, id } = fingerprint(key)!;
  const note = (opts.note ?? "").trim().slice(0, 120);
  await query("INSERT INTO kern_workspace_key(id, key_hash, note, created_by) VALUES ($1, $2, $3, $4)", [id, hash, note, opts.createdBy ?? null]);
  return { key, id, note };
}

export type KeyRefusal = "malformed" | "unknown" | "revoked" | "taken";

export type KeyCheck = { ok: true; id: string; firstUse: boolean } | { ok: false; reason: KeyRefusal };

/**
 * Checks a presented key for `userId` and, when it passes, records the use.
 *
 * The first account to present a key takes it. A key already taken by someone
 * else is refused exactly like an unknown one from the caller's point of view,
 * but reported here as "taken" so the server can say something useful.
 */
export async function redeem(raw: string, userId: string): Promise<KeyCheck> {
  const fp = fingerprint(raw);
  if (!fp) return { ok: false, reason: "malformed" };
  const { hash } = fp;
  const row = await one<{ id: string; redeemed_by: string | null; revoked_at: Date | null }>(
    "SELECT id, redeemed_by, revoked_at FROM kern_workspace_key WHERE key_hash = $1",
    [hash],
  );
  if (!row) return { ok: false, reason: "unknown" };
  if (row.revoked_at) return { ok: false, reason: "revoked" };
  if (row.redeemed_by && row.redeemed_by !== userId) return { ok: false, reason: "taken" };

  const firstUse = !row.redeemed_by;
  // Claim it atomically: two creations racing on a fresh key must not both
  // believe they were first. The WHERE clause lets exactly one win, and the
  // loser is the same account anyway, so it simply counts as a later use.
  if (firstUse) {
    const claimed = await query(
      "UPDATE kern_workspace_key SET redeemed_by = $2, redeemed_at = now(), last_used_at = now(), uses = uses + 1 WHERE id = $1 AND redeemed_by IS NULL RETURNING id",
      [row.id, userId],
    );
    if (!claimed.length) {
      const now = await one<{ redeemed_by: string | null }>("SELECT redeemed_by FROM kern_workspace_key WHERE id = $1", [row.id]);
      if (now?.redeemed_by !== userId) return { ok: false, reason: "taken" };
      await query("UPDATE kern_workspace_key SET last_used_at = now(), uses = uses + 1 WHERE id = $1", [row.id]);
      return { ok: true, id: row.id, firstUse: false };
    }
    return { ok: true, id: row.id, firstUse: true };
  }
  await query("UPDATE kern_workspace_key SET last_used_at = now(), uses = uses + 1 WHERE id = $1", [row.id]);
  return { ok: true, id: row.id, firstUse: false };
}

export async function listKeys(): Promise<(KeyRow & { redeemed_email: string | null })[]> {
  return query<KeyRow & { redeemed_email: string | null }>(
    `SELECT k.id, k.note, k.created_at, k.created_by, k.redeemed_by, k.redeemed_at, k.last_used_at, k.uses, k.revoked_at,
            u.email AS redeemed_email
     FROM kern_workspace_key k LEFT JOIN "user" u ON u.id = k.redeemed_by
     ORDER BY k.revoked_at NULLS FIRST, k.created_at DESC
     LIMIT 500`,
  );
}

export async function revokeKey(id: string): Promise<boolean> {
  const rows = await query("UPDATE kern_workspace_key SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING id", [id]);
  return rows.length > 0;
}

/** Issued, still usable, and already taken — for the management overview. */
export async function keyCounts(): Promise<{ total: number; usable: number; redeemed: number; revoked: number }> {
  const row = await one<{ total: string; usable: string; redeemed: string; revoked: string }>(
    `SELECT count(*) AS total,
            count(*) FILTER (WHERE revoked_at IS NULL) AS usable,
            count(*) FILTER (WHERE redeemed_by IS NOT NULL) AS redeemed,
            count(*) FILTER (WHERE revoked_at IS NOT NULL) AS revoked
     FROM kern_workspace_key`,
  );
  return {
    total: Number(row?.total ?? 0),
    usable: Number(row?.usable ?? 0),
    redeemed: Number(row?.redeemed ?? 0),
    revoked: Number(row?.revoked ?? 0),
  };
}
