// What a workspace key looks like, and what gets stored for one.
//
// Kept apart from workspace-keys.ts, which is the database side and pulls in
// configuration and a connection pool. The format itself is arithmetic on a
// string, so it lives here where it can be read and tested on its own.

import { createHash } from "node:crypto";

/** `k_` then 32 lowercase hex characters. */
const KEY = /^k_([0-9a-f]{32})$/;

/** True when `raw` is shaped like a key, whatever the database says. */
export function looksLikeKey(raw: string): boolean {
  return KEY.test(raw.trim());
}

/**
 * What gets stored for a key: the hash to look it up by, and the short id an
 * administrator sees and revokes by. The id is the first 8 hex of the hash,
 * so it is derived rather than stored separately and reveals nothing about
 * the key. Returns null for anything not shaped like a key.
 */
export function fingerprint(raw: string): { hash: string; id: string } | null {
  const m = KEY.exec(raw.trim());
  if (!m) return null;
  const hash = createHash("sha256").update(`k_${m[1]}`).digest("hex");
  return { hash, id: hash.slice(0, 8) };
}
