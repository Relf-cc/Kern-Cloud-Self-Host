// Managing a space's streams (owners and admins): settings, secrets and
// tokens, previews and test sends, and the delivery log. Secrets are returned
// only when created, rotated or explicitly revealed (which is audited);
// GitHub tokens and Turnstile secrets are write-only.

import { randomBytes } from "node:crypto";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { config } from "../config.js";
import { one, query } from "../db.js";
import { badRequest, body, conflict, HttpError, iso, notFound, requireUser, type Env } from "../lib/http.js";
import { audit, membership, type Membership } from "../lib/spaces.js";
import { deliver, renderSubmission, type Submission } from "../streams/deliver.js";
import { checkRepo, GithubError } from "../streams/github.js";
import { hint, newSecret, newStreamId, normalizePayload, STREAM_ID, validateFields, type Payload } from "../streams/kit.js";
import { mergeConfig, PRESETS, reservedKeys, streamConfig, type StreamConfig } from "../streams/schema.js";
import { configOf, seal, serializeEvent, serializeStream, unseal, type EventRow, type StreamRow } from "../streams/store.js";

export const streams = new Hono<Env>();
streams.use("*", requireUser);

const admin = (c: Context<Env>) => membership(c.get("user").id, c.req.param("space")!, "admin");

async function own(c: Context<Env>, m: Membership): Promise<StreamRow> {
  const id = c.req.param("id") ?? "";
  if (!STREAM_ID.test(id)) throw notFound("Stream");
  const row = await one<StreamRow>("SELECT * FROM kern_stream WHERE id = $1 AND space_id = $2", [id, m.space.id]);
  if (!row) throw notFound("Stream");
  return row;
}

/** Validates a whole config, reporting the first problem with its setting path. */
function parseConfig(raw: unknown): StreamConfig {
  const r = streamConfig.safeParse(raw);
  if (r.success) return r.data;
  const first = r.error.issues[0];
  throw badRequest(`${first?.path.length ? `${first.path.join(".")}: ` : ""}${first?.message ?? "Invalid settings."}`, "invalid_config");
}

const anyObject = z.record(z.string(), z.unknown());

/** Email aliases are chosen here, never by the client (one could claim another stream's mail). */
function stripAlias(patch: Record<string, unknown>): Record<string, unknown> {
  const email = patch.email;
  if (!email || typeof email !== "object" || Array.isArray(email)) return patch;
  const { alias: _ignored, ...rest } = email as Record<string, unknown>;
  return { ...patch, email: rest };
}

/** Keeps the stream's address, or makes one when email is on and it has none. */
function withAlias(cfg: StreamConfig, keep: string | null): StreamConfig {
  const alias = keep ?? (cfg.email.enabled ? Array.from(randomBytes(20), (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("") : null);
  return { ...cfg, email: { ...cfg.email, alias } };
}

// ------------------------------------------------------------ streams

streams.get("/:space/streams", async (c) => {
  const m = await admin(c);
  const rows = await query<StreamRow & { day_total: number; day_failed: number }>(
    `SELECT s.*,
       (SELECT count(*)::int FROM kern_stream_event e WHERE e.stream_id = s.id AND e.received_at > now() - interval '24 hours') AS day_total,
       (SELECT count(*)::int FROM kern_stream_event e WHERE e.stream_id = s.id AND e.received_at > now() - interval '24 hours' AND e.status IN ('failed', 'partial')) AS day_failed
     FROM kern_stream s WHERE s.space_id = $1 ORDER BY s.created_at`,
    [m.space.id],
  );
  return c.json({
    streams: rows.map(({ day_total, day_failed, ...r }) => serializeStream(r as StreamRow, { last24h: { total: day_total, problems: day_failed } })),
    presets: Object.entries(PRESETS).map(([id, p]) => ({ id, description: p.description })),
    limit: config.limits.streamsPerSpace,
    baseUrl: `${config.streamsUrl}/kern/`,
    docsUrl: config.streamsDocsUrl,
  });
});

streams.post("/:space/streams", async (c) => {
  const user = c.get("user");
  const m = await admin(c);
  const input = await body(
    c,
    z.object({
      name: z.string().trim().min(1, "Give the stream a name.").max(80),
      description: z.string().trim().max(500).optional(),
      preset: z.enum(Object.keys(PRESETS) as [string, ...string[]]).optional(),
      config: anyObject.optional(),
    }),
  );
  const count = await one<{ n: number }>("SELECT count(*)::int AS n FROM kern_stream WHERE space_id = $1", [m.space.id]);
  if ((count?.n ?? 0) >= config.limits.streamsPerSpace) throw conflict(`A space can have up to ${config.limits.streamsPerSpace} streams.`, "limit");
  const cfg = withAlias(parseConfig(mergeConfig(mergeConfig({}, input.preset ? PRESETS[input.preset]!.config : {}), stripAlias(input.config ?? {}))), null);
  const id = newStreamId();
  const secret = newSecret();
  const row = await one<StreamRow>(
    `INSERT INTO kern_stream(id, space_id, name, description, config, secret_enc, secret_hint, created_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8) RETURNING *`,
    [id, m.space.id, input.name, input.description ?? "", JSON.stringify(cfg), seal(id, "secret", secret), hint(secret), user.id],
  );
  await audit(m.space.id, user.id, "stream.created", { stream: id, name: input.name });
  return c.json({ stream: serializeStream(row!), secret }, 201);
});

streams.get("/:space/streams/:id", async (c) => {
  const m = await admin(c);
  const row = await own(c, m);
  const counts = await query<{ status: string; day: number; week: number }>(
    `SELECT status, count(*) FILTER (WHERE received_at > now() - interval '24 hours')::int AS day, count(*)::int AS week
     FROM kern_stream_event WHERE stream_id = $1 AND received_at > now() - interval '7 days' GROUP BY status`,
    [row.id],
  );
  const daily = await query<{ day: string; status: string; n: number }>(
    `SELECT to_char(date_trunc('day', received_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day, status, count(*)::int AS n
     FROM kern_stream_event WHERE stream_id = $1 AND received_at > now() - interval '14 days' GROUP BY 1, 2 ORDER BY 1`,
    [row.id],
  );
  return c.json({
    stream: serializeStream(row),
    stats: {
      last24h: Object.fromEntries(counts.map((r) => [r.status, r.day])),
      last7d: Object.fromEntries(counts.map((r) => [r.status, r.week])),
      daily,
    },
  });
});

streams.patch("/:space/streams/:id", async (c) => {
  const user = c.get("user");
  const m = await admin(c);
  const row = await own(c, m);
  const input = await body(
    c,
    z.object({
      name: z.string().trim().min(1).max(80).optional(),
      description: z.string().trim().max(500).optional(),
      enabled: z.boolean().optional(),
      config: anyObject.optional(),
    }),
  );
  const before = configOf(row);
  // Asking for a null alias means "give me a new address".
  const newAddress = (input.config?.email as Record<string, unknown> | undefined)?.alias === null;
  const cfg = input.config ? withAlias(parseConfig(mergeConfig(before, stripAlias(input.config))), newAddress ? null : before.email.alias) : before;
  const repoChanged = (cfg.github.repo ?? "").toLowerCase() !== (before.github.repo ?? "").toLowerCase();
  const updated = await one<StreamRow>(
    `UPDATE kern_stream SET name = coalesce($2, name), description = coalesce($3, description), enabled = coalesce($4, enabled),
       config = $5::jsonb, github_checked_at = CASE WHEN $6 THEN NULL ELSE github_checked_at END, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [row.id, input.name ?? null, input.description ?? null, input.enabled ?? null, JSON.stringify(cfg), repoChanged],
  );
  if (input.enabled !== undefined && input.enabled !== row.enabled) {
    await audit(m.space.id, user.id, input.enabled ? "stream.resumed" : "stream.paused", { stream: row.id, name: updated!.name });
  }
  const fields = [...Object.keys(input).filter((k) => k !== "config" && k !== "enabled"), ...Object.keys(input.config ?? {})];
  if (fields.length) await audit(m.space.id, user.id, "stream.updated", { stream: row.id, name: updated!.name, fields });
  if (before.security.auth !== cfg.security.auth) await audit(m.space.id, user.id, "stream.auth", { stream: row.id, name: updated!.name, from: before.security.auth, to: cfg.security.auth });
  return c.json(serializeStream(updated!));
});

streams.delete("/:space/streams/:id", async (c) => {
  const m = await admin(c);
  const row = await own(c, m);
  await query("DELETE FROM kern_stream WHERE id = $1", [row.id]);
  await audit(m.space.id, c.get("user").id, "stream.deleted", { stream: row.id, name: row.name });
  return c.json({ ok: true });
});

// ------------------------------------------------------------ credentials

/** A new secret. The old one keeps working for `graceHours` so senders can switch over. */
streams.post("/:space/streams/:id/rotate", async (c) => {
  const m = await admin(c);
  const row = await own(c, m);
  const input = await body(c, z.object({ graceHours: z.number().int().min(0).max(168).default(24) }));
  const secret = newSecret();
  const current = unseal(row.id, "secret", row.secret_enc);
  const expires = input.graceHours ? new Date(Date.now() + input.graceHours * 3_600_000) : null;
  const updated = await one<StreamRow>(
    `UPDATE kern_stream SET secret_enc = $2, secret_hint = $3, previous_secret_enc = $4, previous_expires_at = $5, updated_at = now() WHERE id = $1 RETURNING *`,
    [row.id, seal(row.id, "secret", secret), hint(secret), expires ? seal(row.id, "previous", current) : null, expires],
  );
  await audit(m.space.id, c.get("user").id, "stream.rotated", { stream: row.id, name: row.name, graceHours: input.graceHours });
  return c.json({ stream: serializeStream(updated!), secret });
});

/** Shows the current secret again (recorded in the activity log). */
streams.post("/:space/streams/:id/reveal", async (c) => {
  const m = await admin(c);
  const row = await own(c, m);
  await audit(m.space.id, c.get("user").id, "stream.revealed", { stream: row.id, name: row.name });
  return c.json({ secret: unseal(row.id, "secret", row.secret_enc) });
});

/** Ends a rotation's grace period now. */
streams.post("/:space/streams/:id/revoke-previous", async (c) => {
  const m = await admin(c);
  const row = await own(c, m);
  const updated = await one<StreamRow>("UPDATE kern_stream SET previous_secret_enc = NULL, previous_expires_at = NULL, updated_at = now() WHERE id = $1 RETURNING *", [row.id]);
  await audit(m.space.id, c.get("user").id, "stream.revoked_previous", { stream: row.id, name: row.name });
  return c.json(serializeStream(updated!));
});

const ghToken = z
  .string()
  .trim()
  .min(20, "That doesn't look like a GitHub token.")
  .max(255)
  .regex(/^[A-Za-z0-9_]+$/, "That doesn't look like a GitHub token.");

function githubFailure(e: unknown): never {
  if (e instanceof GithubError) throw new HttpError(400, "github", e.message);
  throw e;
}

/** Stores (or with null, removes) the GitHub token, checking it against the repository first. */
streams.put("/:space/streams/:id/github", async (c) => {
  const m = await admin(c);
  const row = await own(c, m);
  const input = await body(c, z.object({ token: ghToken.nullable() }));
  const cfg = configOf(row);
  let check = null;
  if (input.token && cfg.github.repo) check = await checkRepo(input.token, cfg.github.repo).catch(githubFailure);
  const updated = await one<StreamRow>(
    `UPDATE kern_stream SET github_token_enc = $2, github_token_hint = $3, github_checked_at = $4, updated_at = now() WHERE id = $1 RETURNING *`,
    [row.id, input.token ? seal(row.id, "github", input.token) : null, input.token ? hint(input.token) : null, check ? new Date() : null],
  );
  await audit(m.space.id, c.get("user").id, input.token ? "stream.github_token" : "stream.github_token_removed", { stream: row.id, name: row.name });
  return c.json({ stream: serializeStream(updated!), check });
});

/** Checks the stored token can open issues in the repository. */
streams.post("/:space/streams/:id/github/check", async (c) => {
  const m = await admin(c);
  const row = await own(c, m);
  const repo = configOf(row).github.repo;
  if (!repo) throw badRequest("Choose a repository first.");
  if (!row.github_token_enc) throw badRequest("Add a GitHub token first.");
  const check = await checkRepo(unseal(row.id, "github", row.github_token_enc), repo).catch(githubFailure);
  await query("UPDATE kern_stream SET github_checked_at = now() WHERE id = $1", [row.id]);
  return c.json({ check, checkedAt: iso(new Date()) });
});

streams.put("/:space/streams/:id/turnstile", async (c) => {
  const m = await admin(c);
  const row = await own(c, m);
  const input = await body(c, z.object({ secret: z.string().trim().min(10).max(200).regex(/^[A-Za-z0-9_.-]+$/, "That doesn't look like a Turnstile secret key.").nullable() }));
  const updated = await one<StreamRow>("UPDATE kern_stream SET turnstile_secret_enc = $2, updated_at = now() WHERE id = $1 RETURNING *", [row.id, input.secret ? seal(row.id, "turnstile", input.secret) : null]);
  await audit(m.space.id, c.get("user").id, "stream.turnstile", { stream: row.id, name: row.name, set: !!input.secret });
  return c.json(serializeStream(updated!));
});

// ------------------------------------------------------------ previews and tests

function prepare(cfg: StreamConfig, raw: unknown): { payload: Payload; errors: Record<string, string> } {
  const norm = normalizePayload(raw);
  if ("error" in norm) throw badRequest(norm.error, "invalid_payload");
  const payload = norm.payload;
  for (const k of reservedKeys(cfg)) delete payload[k];
  return validateFields(payload, cfg.fields.list, cfg.fields.mode === "strict");
}

const testMeta = (c: Context<Env>): Submission["meta"] => ({ receivedAt: new Date(), origin: null, referer: null, userAgent: `Kern (${c.get("user").name || "test"})`, sender: null, auth: "test", contentType: "application/json" });

/** Renders what a submission would become, without delivering it. Unsaved settings can be passed in `config`. */
streams.post("/:space/streams/:id/preview", async (c) => {
  const m = await admin(c);
  const row = await own(c, m);
  const input = await body(c, z.object({ payload: anyObject, config: anyObject.optional() }));
  const cfg = input.config ? parseConfig(mergeConfig(configOf(row), input.config)) : configOf(row);
  const { payload, errors } = prepare(cfg, input.payload);
  const r = renderSubmission(row, cfg, { payload, meta: testMeta(c), test: true });
  return c.json({ valid: !Object.keys(errors).length, errors, payload, ...r });
});

/** Delivers a test submission for real (marked as a test), skipping authentication and limits. */
streams.post("/:space/streams/:id/test", async (c) => {
  const m = await admin(c);
  const row = await own(c, m);
  const input = await body(c, z.object({ payload: anyObject }));
  const cfg = configOf(row);
  const { payload, errors } = prepare(cfg, input.payload);
  if (Object.keys(errors).length) return c.json({ code: "invalid_fields", message: Object.values(errors).join("; "), fields: errors }, 422);
  const out = await deliver(row, cfg, { payload, meta: testMeta(c), payloadHash: null, idempotencyKey: null, test: true });
  return c.json(out);
});

// ------------------------------------------------------------ delivery log

const STATUSES = ["delivered", "partial", "rejected", "duplicate", "spam", "failed"] as const;

streams.get("/:space/streams/:id/events", async (c) => {
  const m = await admin(c);
  const row = await own(c, m);
  const before = Number.parseInt(c.req.query("before") ?? "", 10);
  const limit = Math.min(100, Math.max(1, Number.parseInt(c.req.query("limit") ?? "", 10) || 50));
  const statuses = (c.req.query("status") ?? "").split(",").filter((s): s is (typeof STATUSES)[number] => (STATUSES as readonly string[]).includes(s));
  const rows = await query<EventRow>(
    `SELECT * FROM kern_stream_event WHERE stream_id = $1 AND ($2::bigint IS NULL OR id < $2) AND (cardinality($3::text[]) = 0 OR status = ANY($3))
     ORDER BY id DESC LIMIT $4`,
    [row.id, Number.isFinite(before) ? before : null, statuses, limit + 1],
  );
  return c.json({ events: rows.slice(0, limit).map((e) => serializeEvent(e)), hasMore: rows.length > limit });
});

async function event(c: Context<Env>, row: StreamRow): Promise<EventRow> {
  const id = Number.parseInt(c.req.param("eventId") ?? "", 10);
  const e = Number.isFinite(id) ? await one<EventRow>("SELECT * FROM kern_stream_event WHERE id = $1 AND stream_id = $2", [id, row.id]) : null;
  if (!e) throw notFound("Delivery");
  return e;
}

streams.get("/:space/streams/:id/events/:eventId", async (c) => {
  const m = await admin(c);
  const row = await own(c, m);
  return c.json(serializeEvent(await event(c, row), true));
});

/** Runs a logged submission through the stream again, with its current settings. */
streams.post("/:space/streams/:id/events/:eventId/redeliver", async (c) => {
  const m = await admin(c);
  const row = await own(c, m);
  const e = await event(c, row);
  if (!e.payload) throw badRequest("This delivery's data wasn't kept, so it can't be sent again.");
  if (e.status === "spam") throw badRequest("Spam can't be redelivered. Unblock the sender and ask them to send it again.");
  const cfg = configOf(row);
  const { payload, errors } = prepare(cfg, e.payload);
  if (Object.keys(errors).length) return c.json({ code: "invalid_fields", message: Object.values(errors).join("; "), fields: errors }, 422);
  const out = await deliver(row, cfg, {
    payload,
    meta: { receivedAt: new Date(), origin: e.origin, referer: null, userAgent: e.user_agent, sender: e.ip_hash, auth: "redeliver", contentType: e.content_type },
    payloadHash: e.payload_hash,
    idempotencyKey: null,
    test: e.test,
  });
  await audit(m.space.id, c.get("user").id, "stream.redelivered", { stream: row.id, name: row.name, event: e.id });
  return c.json(out);
});

/** Silently drops future submissions from the sender of a delivery. */
streams.post("/:space/streams/:id/events/:eventId/block", async (c) => {
  const m = await admin(c);
  const row = await own(c, m);
  const e = await event(c, row);
  if (!e.ip_hash) throw badRequest("This delivery has no sender to block.");
  const cfg = configOf(row);
  if (!cfg.security.blockedSenders.includes(e.ip_hash)) {
    if (cfg.security.blockedSenders.length >= 500) throw conflict("This stream already blocks 500 senders. Remove some first.");
    cfg.security.blockedSenders.push(e.ip_hash);
  }
  const updated = await one<StreamRow>("UPDATE kern_stream SET config = $2::jsonb, updated_at = now() WHERE id = $1 RETURNING *", [row.id, JSON.stringify(cfg)]);
  await audit(m.space.id, c.get("user").id, "stream.blocked", { stream: row.id, name: row.name, sender: e.ip_hash });
  return c.json(serializeStream(updated!));
});

streams.delete("/:space/streams/:id/events", async (c) => {
  const m = await admin(c);
  const row = await own(c, m);
  const r = await query<{ id: number }>("DELETE FROM kern_stream_event WHERE stream_id = $1 RETURNING id", [row.id]);
  await audit(m.space.id, c.get("user").id, "stream.log_cleared", { stream: row.id, name: row.name, entries: r.length });
  return c.json({ ok: true, removed: r.length });
});
