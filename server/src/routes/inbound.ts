// Email to streams. An email worker (deploy/email-worker.js, run by the mail
// provider for the inbound domain) parses each message and posts it here
// with the shared INBOUND_EMAIL_SECRET. The recipient's local part is the
// stream's private alias; the message becomes a submission ({ subject, text,
// from }) and is delivered like any other, with the Message-ID as its
// idempotency key so a retried delivery never makes a duplicate.

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { config } from "../config.js";
import { one } from "../db.js";
import { deliver, logRejection, type Submission } from "../streams/deliver.js";
import { cleanText, normalizePayload, oneLine, RateWindows, safeEqual, sha256, stableStringify, validateFields } from "../streams/kit.js";
import { configOf, senderHash, type StreamRow } from "../streams/store.js";

export const inbound = new Hono();

const limits = new RateWindows();

export function sweepInbound() {
  limits.sweep();
}

const message = z.object({
  to: z.union([z.string().max(2000), z.array(z.string().max(500)).max(50)]),
  from: z.string().max(500),
  subject: z.string().max(5000).default(""),
  text: z.string().max(500_000).default(""),
  messageId: z.string().max(500).nullable().optional(),
});

/** "Ana <ana@example.com>" → "ana@example.com". */
export function address(s: string): string | null {
  const m = /<([^<>\s]+@[^<>\s]+)>/.exec(s) ?? /([^\s<>"]+@[^\s<>"]+)/.exec(s);
  return m ? m[1]!.trim().toLowerCase() : null;
}

/** The stream alias a recipient points at, ignoring +tags. */
export function aliasOf(recipient: string, domain: string): string | null {
  const a = address(recipient);
  if (!a) return null;
  const [local, host] = a.split("@");
  if (!local || host !== domain.toLowerCase()) return null;
  const alias = local.split("+")[0]!;
  return /^[a-z0-9]{20}$/.test(alias) ? alias : null;
}

inbound.post(
  `${config.basePath}/inbound/email`,
  bodyLimit({ maxSize: 1024 * 1024, onError: (c) => c.json({ code: "too_large", message: "That email is too large." }, 413) }),
  async (c) => {
    const secret = config.inboundEmail.secret;
    if (!secret) return c.json({ code: "not_found", message: "Not found." }, 404);
    const given = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1];
    if (!given || !safeEqual(given, secret)) return c.json({ code: "unauthorized", message: "Not allowed." }, 401);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ code: "invalid", message: "Expected JSON." }, 400);
    }
    const parsed = message.safeParse(raw);
    if (!parsed.success) return c.json({ code: "invalid", message: parsed.error.issues[0]?.message ?? "Invalid message." }, 400);
    const msg = parsed.data;
    const recipients = Array.isArray(msg.to) ? msg.to : msg.to.split(",");
    const alias = recipients.map((r) => aliasOf(r, config.inboundEmail.domain)).find((a): a is string => !!a);
    if (!alias) return c.json({ code: "unknown_address", message: "No stream has that address." }, 404);
    const stream = await one<StreamRow>(
      `SELECT st.* FROM kern_stream st JOIN kern_space sp ON sp.id = st.space_id
       WHERE st.config->'email'->>'alias' = $1 AND sp.deleted_at IS NULL`,
      [alias],
    );
    if (!stream) return c.json({ code: "unknown_address", message: "No stream has that address." }, 404);
    const cfg = configOf(stream);
    if (!stream.enabled || !cfg.email.enabled) return c.json({ code: "stream_paused", message: "This address isn't accepting email right now." }, 403);

    const from = address(msg.from) ?? "";
    const hit = limits.hit(`email:${stream.id}`, config.limits.emailHourly, 3_600_000);
    if (!hit.ok) return c.json({ code: "rate_limited", message: "Too many emails; try again later." }, 429);

    const text = cleanText(msg.text).replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 20_000);
    const norm = normalizePayload({ subject: oneLine(msg.subject).slice(0, 300), text, from });
    if ("error" in norm) return c.json({ code: "invalid", message: norm.error }, 400);
    const sub: Submission = {
      payload: norm.payload,
      meta: { receivedAt: new Date(), origin: null, referer: null, userAgent: "email", sender: from ? senderHash(from) : null, auth: "email", contentType: "message/rfc822" },
      payloadHash: null,
      idempotencyKey: msg.messageId ? `email:${msg.messageId}`.slice(0, 200).replace(/[^\x21-\x7e]/g, "") : null,
      test: false,
    };
    const started = Date.now();

    if (cfg.email.allowedSenders.length && !cfg.email.allowedSenders.includes(from)) {
      await logRejection(stream, cfg, sub, "rejected", "sender_not_allowed", `Email from ${from || "an unknown sender"} isn't on this stream's allowed list.`, started);
      return c.json({ code: "sender_not_allowed", message: "That sender isn't allowed." }, 403);
    }
    if (sub.idempotencyKey) {
      const prior = await one<{ id: number }>("SELECT id FROM kern_stream_event WHERE stream_id = $1 AND idempotency_key = $2", [stream.id, sub.idempotencyKey]);
      if (prior) return c.json({ ok: true, id: prior.id, duplicate: true });
    }
    const v = validateFields(sub.payload, cfg.fields.list, cfg.fields.mode === "strict");
    sub.payload = v.payload;
    if (Object.keys(v.errors).length) {
      const id = await logRejection(stream, cfg, sub, "rejected", "invalid_fields", Object.values(v.errors).join("; "), started);
      return c.json({ ok: false, id, code: "invalid_fields", message: "The email didn't match this stream's fields." }, 422);
    }
    sub.payloadHash = sha256(stableStringify(sub.payload));
    const out = await deliver(stream, cfg, sub);
    return c.json({ ok: out.status !== "failed", id: out.eventId, status: out.status }, out.status === "failed" ? 502 : 201);
  },
);
