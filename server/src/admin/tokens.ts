// Management tokens: how Kern Platform and kernctl prove they may manage this
// instance.
//
// A token reads `kern_<id>_<secret>`. Only the SHA-256 of the secret half is
// stored, so a stolen database yields no working tokens, and the id half lets
// a lookup find one row rather than comparing against every token. The whole
// token is shown exactly once, when it is created.
//
// On first start, when no tokens exist, one is minted automatically and
// written where the installer told us to put it (ADMIN_TOKEN_FILE). That is
// how `kernctl` on the same machine works with no setup: it reads the file.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { one, query } from "../db.js";
import { config } from "../config.js";

export type Scope = "full" | "read";

export interface TokenRow {
  id: string;
  name: string;
  scope: Scope;
  created_at: Date;
  created_by: string | null;
  last_used_at: Date | null;
  last_used_ip: string | null;
  expires_at: Date | null;
  revoked_at: Date | null;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Parses `kern_<16 hex>_<secret>`; anything else is not a token. */
export function parseToken(raw: string): { id: string; secret: string } | null {
  const m = /^kern_([0-9a-f]{16})_([A-Za-z0-9_-]{32,96})$/.exec(raw.trim());
  return m ? { id: m[1]!, secret: m[2]! } : null;
}

export interface Minted {
  /** The full token. Never stored, never logged; show it once. */
  token: string;
  id: string;
  name: string;
  scope: Scope;
  expiresAt: Date | null;
}

export async function mint(opts: { name: string; scope?: Scope; days?: number | null; createdBy?: string | null }): Promise<Minted> {
  const id = randomBytes(8).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  const scope: Scope = opts.scope === "read" ? "read" : "full";
  const expiresAt = opts.days && opts.days > 0 ? new Date(Date.now() + opts.days * 86_400_000) : null;
  await query("INSERT INTO kern_admin_token(id, secret_hash, name, scope, created_by, expires_at) VALUES ($1, $2, $3, $4, $5, $6)", [
    id,
    sha256(secret),
    opts.name.trim().slice(0, 80) || "Unnamed token",
    scope,
    opts.createdBy ?? null,
    expiresAt,
  ]);
  return { token: `kern_${id}_${secret}`, id, name: opts.name, scope, expiresAt };
}

/** Resolves a presented token, or null when it doesn't authorise anything. */
export async function verify(raw: string, ip: string | null): Promise<{ id: string; name: string; scope: Scope } | null> {
  const parsed = parseToken(raw);
  if (!parsed) return null;
  const row = await one<{ id: string; secret_hash: string; name: string; scope: Scope; expires_at: Date | null; revoked_at: Date | null }>(
    "SELECT id, secret_hash, name, scope, expires_at, revoked_at FROM kern_admin_token WHERE id = $1",
    [parsed.id],
  );
  if (!row || row.revoked_at || (row.expires_at && row.expires_at.getTime() < Date.now())) return null;
  const presented = Buffer.from(sha256(parsed.secret), "hex");
  const stored = Buffer.from(row.secret_hash, "hex");
  if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) return null;
  // Best effort: a failed touch must not refuse a valid token.
  void query("UPDATE kern_admin_token SET last_used_at = now(), last_used_ip = $2 WHERE id = $1", [row.id, ip]).catch(() => undefined);
  return { id: row.id, name: row.name, scope: row.scope };
}

export async function listTokens(): Promise<TokenRow[]> {
  return query<TokenRow>(
    `SELECT id, name, scope, created_at, created_by, last_used_at, last_used_ip, expires_at, revoked_at
     FROM kern_admin_token ORDER BY revoked_at NULLS FIRST, created_at DESC`,
  );
}

export async function revoke(id: string): Promise<boolean> {
  const rows = await query("UPDATE kern_admin_token SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING id", [id]);
  return rows.length > 0;
}

/** How many tokens could still be used right now. */
export async function activeCount(): Promise<number> {
  const row = await one<{ n: string }>("SELECT count(*) AS n FROM kern_admin_token WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())");
  return Number(row?.n ?? 0);
}

/**
 * On an instance with no usable tokens, mints one and writes it to
 * ADMIN_TOKEN_FILE so the machine's own tools can manage the server. Returns
 * the token when one was created, so startup can print it for a deployment
 * that has nowhere to write.
 */
export async function ensureBootstrapToken(): Promise<Minted | null> {
  if ((await activeCount()) > 0) return null;
  const minted = await mint({ name: "Bootstrap (first start)", createdBy: "bootstrap" });
  const path = config.admin.tokenFile;
  if (path) {
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${minted.token}\n`, { encoding: "utf8", mode: 0o600 });
      // mkdir/writeFile modes are masked; set it explicitly.
      await chmod(path, 0o600);
      console.log(`[admin] no management token existed; wrote a new one to ${path}`);
      return null;
    } catch (e) {
      console.error(`[admin] couldn't write the management token to ${path}:`, (e as Error).message);
    }
  }
  return minted;
}
