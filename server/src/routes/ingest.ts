// Public stream endpoints: POST <STREAMS_URL>/kern/<64-hex id>.
//
// A request passes through, in order: the stream lookup, the paused check,
// rate limits (per sender and per stream), the address allowlist, blocked
// senders, origin rules, the size limit, authentication (none, a bearer
// secret, or an HMAC signature with replay protection), body parsing, the
// honeypot, Cloudflare Turnstile, field validation, idempotency keys and
// duplicate detection - and is then delivered. Refusals before
// authentication aren't logged, so nobody can fill a stream's log from
// outside; spam is answered exactly like success so bots learn nothing.

import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { config } from "../config.js";
import { one } from "../db.js";
import { escapeHtml } from "../mail.js";
import { deliver, logRejection, type Outcome, type Submission } from "../streams/deliver.js";
import {
  formToPayload,
  getPath,
  deletePath,
  ipAllowed,
  normalizeOrigin,
  normalizePayload,
  originAllowed,
  RateWindows,
  safeEqual,
  SeenSet,
  sha256,
  SIGNATURE_HEADER,
  stableStringify,
  validateFields,
  verifySignature,
  type Payload,
} from "../streams/kit.js";
import { reservedKeys, type StreamConfig } from "../streams/schema.js";
import { activeSecrets, configOf, senderHash, unseal, type StreamRow } from "../streams/store.js";

export const ingest = new Hono();

const PATH = "/kern/:id{[0-9a-f]{64}}";
const limits = new RateWindows();
const replays = new SeenSet();

/** Forgets expired rate windows and signatures (called periodically). */
export function sweepIngest() {
  limits.sweep();
  replays.sweep();
}

type Status = 200 | 201 | 202 | 400 | 401 | 403 | 404 | 405 | 413 | 415 | 422 | 429 | 500 | 502 | 503;

class Refusal extends Error {
  constructor(
    public status: Status,
    public code: string,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

function clientIp(c: Context): string {
  const cf = c.req.header("cf-connecting-ip");
  if (cf) return cf.trim();
  const xff = c.req.header("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  try {
    return getConnInfo(c).remote.address ?? "0.0.0.0";
  } catch {
    return "0.0.0.0";
  }
}

async function load(id: string): Promise<StreamRow | null> {
  return one<StreamRow>(
    `SELECT st.* FROM kern_stream st JOIN kern_space sp ON sp.id = st.space_id
     WHERE st.id = $1 AND sp.deleted_at IS NULL`,
    [id],
  );
}

/** The Access-Control-Allow-Origin value for a request, or null. */
function corsOrigin(cfg: StreamConfig, origin: string | undefined): string | null {
  if (!origin || !normalizeOrigin(origin)) return null;
  if (cfg.security.allowedOrigins.length) return originAllowed(origin, cfg.security.allowedOrigins) ? origin : null;
  return origin;
}

function setCors(c: Context, allow: string | null) {
  c.header("Vary", "Origin");
  if (!allow) return;
  c.header("Access-Control-Allow-Origin", allow);
  c.header("Access-Control-Expose-Headers", "Retry-After, Kern-Event");
}

const wantsHtml = (c: Context, contentType: string) =>
  (contentType.startsWith("application/x-www-form-urlencoded") || contentType.startsWith("multipart/form-data")) && (c.req.header("accept") ?? "").includes("text/html");

function page(title: string, message: string, ok: boolean) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#f4f4f5;--card:#fff;--text:#18181b;--muted:#71717a;--line:#e4e4e7;--accent:${ok ? "#16a34a" : "#dc2626"}}
@media (prefers-color-scheme:dark){:root{--bg:#111;--card:#1a1a1a;--text:#f4f4f5;--muted:#a1a1aa;--line:#2a2a2a}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:15px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:16px}
.card{width:100%;max-width:420px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px;text-align:center}
.dot{width:12px;height:12px;border-radius:50%;background:var(--accent);margin:0 auto 14px}
h1{font-size:18px;margin:0 0 6px}p{margin:0;color:var(--muted)}a{color:inherit}
</style></head><body><main class="card"><div class="dot"></div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>
<p style="margin-top:14px"><a href="javascript:history.back()">Go back</a></p></main></body></html>`;
}

function withQuery(url: string, params: Record<string, string>) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

async function parseBody(contentType: string, raw: Uint8Array): Promise<{ payload: unknown; note: string | null }> {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(raw);
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  if (type === "application/json" || type.endsWith("+json") || (!type && text.trim().startsWith("{"))) {
    try {
      return { payload: JSON.parse(text), note: null };
    } catch {
      throw new Refusal(400, "invalid_json", "The body isn't valid JSON.");
    }
  }
  if (type === "text/plain") {
    // sendBeacon and no-preflight fetches send JSON as text/plain.
    const t = text.trim();
    if (t.startsWith("{")) {
      try {
        return { payload: JSON.parse(t), note: null };
      } catch {
        /* plain text after all */
      }
    }
    return { payload: { message: text }, note: null };
  }
  if (type === "application/x-www-form-urlencoded") return { payload: formToPayload(new URLSearchParams(text)), note: null };
  if (type === "multipart/form-data") {
    const form = await new Request("http://local/", { method: "POST", headers: { "content-type": contentType }, body: raw }).formData().catch(() => {
      throw new Refusal(400, "invalid_form", "The form data couldn't be read.");
    });
    const entries: [string, string][] = [];
    let files = 0;
    for (const [k, v] of form.entries()) {
      if (typeof v === "string") entries.push([k, v]);
      else files++;
    }
    return { payload: formToPayload(entries), note: files ? `${files} attached file${files === 1 ? " was" : "s were"} ignored; streams accept text only.` : null };
  }
  throw new Refusal(415, "unsupported_type", "Send JSON (application/json), form fields, or plain text.");
}

async function verifyTurnstile(secret: string, token: string, ip: string): Promise<boolean> {
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: new URLSearchParams({ secret, response: token, remoteip: ip }),
      signal: AbortSignal.timeout(8000),
    });
    const j = (await res.json()) as { success?: boolean };
    return j.success === true;
  } catch {
    return false;
  }
}

const isBlank = (v: unknown) => v === undefined || v === null || (typeof v === "string" && !v.trim()) || (Array.isArray(v) && !v.length);

// ------------------------------------------------------------ routes

ingest.options(PATH, async (c) => {
  const stream = await load(c.req.param("id"));
  if (!stream) return c.body(null, 404);
  const allow = corsOrigin(configOf(stream), c.req.header("origin"));
  setCors(c, allow);
  if (!allow) return c.body(null, 403);
  c.header("Access-Control-Allow-Methods", "POST, OPTIONS");
  c.header("Access-Control-Allow-Headers", "Content-Type, Authorization, Kern-Signature, Kern-Turnstile, Idempotency-Key");
  c.header("Access-Control-Max-Age", "600");
  return c.body(null, 204);
});

ingest.get(PATH, (c) => {
  c.header("Allow", "POST, OPTIONS");
  return c.json({ ok: false, code: "method_not_allowed", message: "Kern streams accept POST requests.", docs: config.streamsDocsUrl }, 405);
});

ingest.post(
  PATH,
  bodyLimit({
    maxSize: config.limits.streamBodyBytes,
    onError: (c) => c.json({ ok: false, code: "too_large", message: "That submission is too large." }, 413),
  }),
  async (c) => {
    const started = Date.now();
    const contentType = c.req.header("content-type") ?? "";
    const html = wantsHtml(c, contentType);
    let stream: StreamRow | null = null;
    let cfg: StreamConfig | null = null;

    const respond = (status: Status, body: Record<string, unknown>) => {
      if (html) {
        const ok = body.ok === true;
        const redirect = cfg?.responses.redirectUrl;
        if (redirect) return c.redirect(withQuery(redirect, ok ? { kern: "ok" } : { kern: "error", code: String(body.code ?? "error") }), 303);
        return c.html(page(ok ? "Sent" : "Not sent", String(body.message ?? ""), ok), status);
      }
      return c.json(body, status);
    };
    const success = (eventId: number, extra: Record<string, unknown> = {}) => {
      c.header("Kern-Event", String(eventId));
      return respond(201, { ok: true, id: eventId, status: "delivered", message: cfg!.responses.successMessage, ...extra });
    };

    try {
      const id = c.req.param("id");
      stream = await load(id);
      if (!stream) throw new Refusal(404, "not_found", "There's no stream at this address.");
      cfg = configOf(stream);
      const sec = cfg.security;
      const origin = c.req.header("origin");
      setCors(c, corsOrigin(cfg, origin));
      if (!stream.enabled) throw new Refusal(403, "stream_paused", "This stream isn't accepting submissions right now.");

      const ip = clientIp(c);
      const sender = senderHash(ip);
      for (const [key, max, ms] of [
        [`m:${id}:${sender}`, sec.rateLimit.perMinute, 60_000],
        [`h:${id}:${sender}`, sec.rateLimit.perHour, 3_600_000],
        [`s:${id}`, Math.min(sec.rateLimit.streamPerHour, config.limits.streamHourly), 3_600_000],
      ] as const) {
        const r = limits.hit(key, max, ms);
        if (!r.ok) {
          c.header("Retry-After", String(r.retryAfter));
          throw new Refusal(429, "rate_limited", `Too many submissions. Try again in ${r.retryAfter} seconds.`, { retryAfter: r.retryAfter });
        }
      }
      if (!ipAllowed(ip, sec.ipAllowlist)) throw new Refusal(403, "ip_not_allowed", "Submissions from this address aren't allowed.");
      if (sec.allowedOrigins.length && origin && !originAllowed(origin, sec.allowedOrigins)) throw new Refusal(403, "origin_not_allowed", "This website isn't allowed to send to this stream.");
      if (sec.auth === "public" && sec.requireOrigin && !origin) throw new Refusal(403, "origin_required", "Send submissions from a web page (the request had no Origin header).");

      const raw = new Uint8Array(await c.req.arrayBuffer());
      if (raw.length > sec.maxBodyKb * 1024) throw new Refusal(413, "too_large", `Submissions to this stream can be at most ${sec.maxBodyKb} KB.`);

      // Authentication.
      if (sec.auth === "token") {
        const given = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1];
        if (!given) throw new Refusal(401, "missing_token", "Send the stream secret as Authorization: Bearer <secret>.");
        if (!activeSecrets(stream).some((s) => safeEqual(s, given))) throw new Refusal(401, "bad_token", "That stream secret isn't valid.");
      } else if (sec.auth === "signature") {
        const check = verifySignature(c.req.header(SIGNATURE_HEADER), activeSecrets(stream), raw, Math.floor(Date.now() / 1000), sec.signatureToleranceSec);
        if (!check.ok) throw new Refusal(401, check.code, check.message);
        if (!replays.add(`${id}:${check.signature}`, (check.t + sec.signatureToleranceSec) * 1000)) {
          throw new Refusal(401, "replayed_signature", "This signed request was already received. Sign each request afresh.");
        }
      }

      const parsed = await parseBody(contentType, raw);
      if ((contentType.startsWith("application/x-www-form-urlencoded") || contentType.startsWith("multipart/form-data")) && !sec.allowFormPosts) {
        throw new Refusal(415, "forms_disabled", "This stream only accepts JSON.");
      }
      const norm = normalizePayload(parsed.payload);
      if ("error" in norm) throw new Refusal(400, "invalid_payload", norm.error);
      let payload: Payload = norm.payload;

      const sub: Submission = {
        payload,
        meta: {
          receivedAt: new Date(),
          origin: origin ? normalizeOrigin(origin) : null,
          referer: (c.req.header("referer") ?? "").slice(0, 500) || null,
          userAgent: c.req.header("user-agent") ?? null,
          sender,
          auth: sec.auth,
          contentType: contentType.split(";")[0]!.trim().slice(0, 100) || null,
        },
        payloadHash: null,
        idempotencyKey: null,
        test: false,
      };

      // Spam: answered like a success, logged without the data.
      if (sec.blockedSenders.includes(sender)) {
        return success(await logRejection(stream, cfg, sub, "spam", "blocked_sender", "From a blocked sender.", started));
      }
      if (sec.honeypotField && !isBlank(getPath(payload, sec.honeypotField))) {
        return success(await logRejection(stream, cfg, sub, "spam", "honeypot", "The hidden honeypot field was filled in.", started));
      }

      const turnstileToken = (getPath(payload, "cf-turnstile-response") as string | undefined) ?? c.req.header("kern-turnstile");
      for (const k of reservedKeys(cfg)) deletePath(payload, k);
      if (sec.turnstile && sec.auth === "public") {
        if (!stream.turnstile_secret_enc) throw new Refusal(503, "captcha_unavailable", "This stream's spam check isn't set up yet.");
        if (typeof turnstileToken !== "string" || !turnstileToken) throw new Refusal(403, "captcha_required", "Complete the spam check and try again.");
        const ok = await verifyTurnstile(unseal(stream.id, "turnstile", stream.turnstile_secret_enc), turnstileToken, ip);
        if (!ok) {
          await logRejection(stream, cfg, sub, "spam", "captcha_failed", "The Turnstile check failed.", started);
          throw new Refusal(403, "captcha_failed", "The spam check failed. Try again.");
        }
      }

      const v = validateFields(payload, cfg.fields.list, cfg.fields.mode === "strict");
      payload = v.payload;
      sub.payload = payload;
      if (Object.keys(v.errors).length) {
        const first = Object.values(v.errors)[0]!;
        const eventId = await logRejection(stream, cfg, sub, "rejected", "invalid_fields", Object.values(v.errors).join("; "), started);
        c.header("Kern-Event", String(eventId));
        throw new Refusal(422, "invalid_fields", `${first[0]!.toUpperCase()}${first.slice(1)}.`, { fields: v.errors });
      }

      // Idempotency: the same key returns the first result.
      const key = c.req.header("idempotency-key")?.trim();
      if (key) {
        if (key.length > 200 || !/^[\x21-\x7e]+$/.test(key)) throw new Refusal(400, "invalid_idempotency_key", "Idempotency keys are up to 200 visible ASCII characters.");
        sub.idempotencyKey = key;
        const prior = await one<{ id: number; status: string; task_id: string | null; issue_number: number | null; issue_url: string | null }>(
          "SELECT id, status, task_id, issue_number, issue_url FROM kern_stream_event WHERE stream_id = $1 AND idempotency_key = $2",
          [stream.id, key],
        );
        if (prior) {
          c.header("Kern-Event", String(prior.id));
          return respond(200, { ok: true, id: prior.id, status: prior.status, duplicate: true, message: cfg.responses.successMessage, ...ids(cfg, prior.task_id, prior.issue_url ? { number: prior.issue_number!, url: prior.issue_url } : null) });
        }
      }

      sub.payloadHash = sha256(stableStringify(payload));
      if (sec.dedupeMinutes > 0) {
        const dup = await one<{ id: number; task_id: string | null; issue_number: number | null; issue_url: string | null }>(
          `SELECT id, task_id, issue_number, issue_url FROM kern_stream_event WHERE stream_id = $1 AND payload_hash = $2 AND status IN ('delivered', 'partial')
             AND received_at > now() - make_interval(mins => $3::int) ORDER BY received_at DESC LIMIT 1`,
          [stream.id, sub.payloadHash, sec.dedupeMinutes],
        );
        if (dup) {
          const issue = dup.issue_url ? { number: dup.issue_number!, url: dup.issue_url } : null;
          const eventId = await logRejection(stream, cfg, sub, "duplicate", "duplicate", `Same as delivery #${dup.id}.`, started, { taskId: dup.task_id, issue });
          c.header("Kern-Event", String(eventId));
          return respond(200, { ok: true, id: eventId, status: "duplicate", duplicate: true, message: cfg.responses.successMessage, ...ids(cfg, dup.task_id, issue) });
        }
      }

      const out = await deliver(stream, cfg, sub);
      return result(c, cfg, out, parsed.note, respond);
    } catch (e) {
      if (e instanceof Refusal) {
        return respond(e.status, { ok: false, code: e.code, message: e.message, ...e.extra, ...(e.status >= 400 && e.status !== 429 ? { docs: config.streamsDocsUrl } : {}) });
      }
      console.error("[streams] ingest failed", e);
      return respond(500, { ok: false, code: "server", message: "Something went wrong on the server. Try again in a moment." });
    }
  },
);

/** Task and issue ids, only for authenticated streams that ask for them. */
function ids(cfg: StreamConfig, taskId: string | null, issue: { number: number; url: string } | null) {
  if (!cfg.responses.returnIds || cfg.security.auth === "public") return {};
  return { taskId, issue };
}

function result(c: Context, cfg: StreamConfig, out: Outcome, note: string | null, respond: (s: Status, b: Record<string, unknown>) => Response | Promise<Response>) {
  c.header("Kern-Event", String(out.eventId));
  const authed = cfg.security.auth !== "public";
  if (out.status === "failed") {
    // The submission is in the log and can be redelivered from Kern.
    return respond(502, { ok: false, id: out.eventId, code: out.code ?? "failed", message: authed ? (out.message ?? "Delivery failed.") : "The submission couldn't be delivered. Try again later.", retryable: true });
  }
  const warnings = [out.status === "partial" ? out.message : null, note].filter(Boolean);
  return respond(201, {
    ok: true,
    id: out.eventId,
    status: out.status,
    message: cfg.responses.successMessage,
    ...(authed && warnings.length ? { warnings } : {}),
    ...ids(cfg, out.taskId ?? out.inboxId, out.issue),
  });
}
