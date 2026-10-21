// Stream rows: loading, credentials (decrypted only when needed) and the
// shape the app sees. Secrets and tokens are encrypted with a key derived
// from STREAMS_ENCRYPTION_KEY (or BETTER_AUTH_SECRET); sender addresses are
// never stored, only a keyed hash that can't be reversed.

import { createHmac, hkdfSync } from "node:crypto";
import { config } from "../config.js";
import { one, type Db } from "../db.js";
import { iso } from "../lib/http.js";
import { decrypt, encrypt, normalizeIp } from "./kit.js";
import { streamConfig, type StreamConfig } from "./schema.js";

function keys() {
  let root: Buffer;
  if (config.streamsKey) {
    root = Buffer.from(config.streamsKey, "base64");
    if (root.length !== 32) throw new Error("STREAMS_ENCRYPTION_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32).");
  } else {
    root = Buffer.from(config.authSecret, "utf8");
  }
  const derive = (info: string) => Buffer.from(hkdfSync("sha256", root, "kern-streams", info, 32));
  return { encryption: derive("encryption-v1"), sender: derive("sender-hash-v1") };
}

// Derived once at startup, so a bad key stops the server immediately.
const KEYS = keys();

export type SecretKind = "secret" | "previous" | "github" | "turnstile";

export const seal = (streamId: string, kind: SecretKind, plain: string) => encrypt(KEYS.encryption, plain, `${streamId}:${kind}`);
export const unseal = (streamId: string, kind: SecretKind, blob: string) => decrypt(KEYS.encryption, blob, `${streamId}:${kind}`);

/** A stable, non-reversible id for a sender address (16 hex characters). */
export function senderHash(ip: string): string {
  return createHmac("sha256", KEYS.sender).update(normalizeIp(ip)).digest("hex").slice(0, 16);
}

export interface StreamRow {
  id: string;
  space_id: string;
  name: string;
  description: string;
  enabled: boolean;
  config: Record<string, unknown>;
  secret_enc: string;
  secret_hint: string;
  previous_secret_enc: string | null;
  previous_expires_at: Date | null;
  github_token_enc: string | null;
  github_token_hint: string | null;
  github_checked_at: Date | null;
  turnstile_secret_enc: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
  last_delivery_at: Date | null;
  delivery_count: number;
}

/** The stored config with defaults filled in. A config that no longer parses falls back to defaults for the bad parts. */
export function configOf(row: Pick<StreamRow, "config">): StreamConfig {
  const parsed = streamConfig.safeParse(row.config ?? {});
  if (parsed.success) return parsed.data;
  console.error("[streams] stored config didn't validate; using defaults for invalid parts", parsed.error.issues[0]);
  const fallback = streamConfig.parse({});
  for (const k of Object.keys(fallback) as (keyof StreamConfig)[]) {
    const part = streamConfig.shape[k].safeParse((row.config as Record<string, unknown>)[k]);
    if (part.success) (fallback as Record<string, unknown>)[k] = part.data;
  }
  return fallback;
}

/** The secrets that currently authenticate requests (two during a rotation). */
export function activeSecrets(row: StreamRow, now = Date.now()): string[] {
  const out = [unseal(row.id, "secret", row.secret_enc)];
  if (row.previous_secret_enc && row.previous_expires_at && row.previous_expires_at.getTime() > now) {
    try {
      out.push(unseal(row.id, "previous", row.previous_secret_enc));
    } catch (e) {
      console.error("[streams] previous secret unreadable", e);
    }
  }
  return out;
}

export async function streamById(id: string, db?: Db): Promise<StreamRow | null> {
  return one<StreamRow>("SELECT * FROM kern_stream WHERE id = $1", [id], db);
}

export const streamUrl = (id: string) => `${config.streamsUrl}/kern/${id}`;

/** The private capture page for a stream (the secret goes in the fragment). */
export const captureUrl = (id: string) => `${config.streamsUrl}/kern/${id}/capture`;

/** The stream's email address, when email is on and the server accepts mail. */
function emailInfo(r: StreamRow) {
  const cfg = configOf(r);
  const available = !!config.inboundEmail.secret;
  return { available, address: available && cfg.email.enabled && cfg.email.alias ? `${cfg.email.alias}@${config.inboundEmail.domain}` : null };
}

export function serializeStream(r: StreamRow, extra: Record<string, unknown> = {}) {
  return {
    id: r.id,
    spaceId: r.space_id,
    url: streamUrl(r.id),
    name: r.name,
    description: r.description,
    enabled: r.enabled,
    config: configOf(r),
    secretHint: r.secret_hint,
    previousSecretExpiresAt: r.previous_expires_at && r.previous_expires_at.getTime() > Date.now() ? iso(r.previous_expires_at) : null,
    github: { tokenSet: !!r.github_token_enc, tokenHint: r.github_token_hint, checkedAt: iso(r.github_checked_at) },
    turnstile: { secretSet: !!r.turnstile_secret_enc },
    email: emailInfo(r),
    createdBy: r.created_by,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    lastDeliveryAt: iso(r.last_delivery_at),
    deliveryCount: Number(r.delivery_count),
    ...extra,
  };
}

export interface EventRow {
  id: number;
  stream_id: string;
  received_at: Date;
  status: string;
  code: string | null;
  message: string | null;
  test: boolean;
  auth: string | null;
  ip_hash: string | null;
  origin: string | null;
  user_agent: string | null;
  content_type: string | null;
  payload: Record<string, unknown> | null;
  payload_hash: string | null;
  idempotency_key: string | null;
  task_id: string | null;
  inbox_id: string | null;
  issue_number: number | null;
  issue_url: string | null;
  duration_ms: number | null;
}

export function serializeEvent(e: EventRow, full = false) {
  return {
    id: e.id,
    receivedAt: iso(e.received_at),
    status: e.status,
    code: e.code,
    message: e.message,
    test: e.test,
    auth: e.auth,
    sender: e.ip_hash,
    origin: e.origin,
    userAgent: e.user_agent,
    contentType: e.content_type,
    idempotencyKey: e.idempotency_key,
    taskId: e.task_id,
    inboxId: e.inbox_id,
    issue: e.issue_url ? { number: e.issue_number, url: e.issue_url } : null,
    durationMs: e.duration_ms,
    hasPayload: e.payload !== null,
    ...(full ? { payload: e.payload } : {}),
  };
}
