// Stream building blocks with no I/O: identifiers and secrets, encryption at
// rest, request signatures, templates, field validation, origin and address
// matching and rate windows. Everything here is pure (apart from randomness)
// so it can be unit-tested without a database.

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { BlockList, isIP } from "node:net";

// ------------------------------------------------------------ identifiers

/** The public stream id in the URL: 32 random bytes as 64 hex characters. */
export function newStreamId(): string {
  return randomBytes(32).toString("hex");
}

export const STREAM_ID = /^[0-9a-f]{64}$/;

/** A stream secret: "kss_" and 43 base64url characters (256 bits). */
export function newSecret(): string {
  return `kss_${randomBytes(32).toString("base64url")}`;
}

/** What the app shows for a stored secret or token: a prefix and the last four characters. */
export function hint(secret: string): string {
  // Only a vendor prefix - lowercase letters up to the first underscore, and
  // the "pat_" that GitHub puts after its own. The pattern is bounded and
  // case-sensitive on purpose: a greedy [a-z_]+_ also swallows the start of a
  // base64url secret ("kss_ARsYLFO_…"), which would put part of the secret in
  // a string the app shows in plain sight.
  const prefix = /^[a-z]{2,10}_(?:pat_)?/.exec(secret)?.[0] ?? "";
  return `${prefix}…${secret.slice(-4)}`;
}

/** Time-ordered UUID (v7), the same kind of id the app gives new records. */
export function uuidv7(now = Date.now()): string {
  const b = randomBytes(16);
  b.writeUIntBE(now, 0, 6);
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ------------------------------------------------------------ encryption at rest

/**
 * AES-256-GCM with a random 96-bit nonce. The associated data binds a
 * ciphertext to its row and purpose, so a value copied into another stream
 * (or another column) fails to decrypt.
 */
export function encrypt(key: Buffer, plain: string, aad: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1.${iv.toString("base64url")}.${c.getAuthTag().toString("base64url")}.${ct.toString("base64url")}`;
}

export function decrypt(key: Buffer, blob: string, aad: string): string {
  const [v, iv, tag, ct] = blob.split(".");
  if (v !== "v1" || !iv || !tag || ct === undefined) throw new Error("Unknown ciphertext format.");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  d.setAAD(Buffer.from(aad, "utf8"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const x = createHash("sha256").update(a).digest();
  const y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y) && a.length === b.length;
}

// ------------------------------------------------------------ signatures

export const SIGNATURE_HEADER = "kern-signature";

/** The signature a sender computes: HMAC-SHA256(secret, "<t>.<raw body>"), hex. */
export function sign(secret: string, timestamp: number, body: string | Uint8Array): string {
  const h = createHmac("sha256", secret);
  h.update(`${timestamp}.`);
  h.update(body);
  return h.digest("hex");
}

/** "t=1700000000,v1=abc…[,v1=def…]" → its parts. */
export function parseSignature(header: string | undefined | null): { t: number; v1: string[] } | null {
  if (!header || header.length > 1024) return null;
  let t = Number.NaN;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.trim().split("=", 2);
    if (k === "t" && v && /^\d{1,12}$/.test(v)) t = Number(v);
    else if (k === "v1" && v && /^[0-9a-f]{64}$/i.test(v)) v1.push(v.toLowerCase());
  }
  return Number.isFinite(t) && v1.length ? { t, v1 } : null;
}

export type SignatureCheck = { ok: true; signature: string; t: number } | { ok: false; code: "missing_signature" | "malformed_signature" | "stale_signature" | "bad_signature"; message: string };

/**
 * Checks a Kern-Signature header against every currently valid secret (two
 * during a rotation). The timestamp must be within `toleranceSec` of now.
 */
export function verifySignature(header: string | undefined | null, secrets: string[], body: Uint8Array, nowSec: number, toleranceSec: number): SignatureCheck {
  if (!header) return { ok: false, code: "missing_signature", message: "Sign the request with the Kern-Signature header." };
  const parsed = parseSignature(header);
  if (!parsed) return { ok: false, code: "malformed_signature", message: 'The Kern-Signature header should look like "t=<unix seconds>,v1=<hex HMAC>".' };
  if (Math.abs(nowSec - parsed.t) > toleranceSec) {
    return { ok: false, code: "stale_signature", message: `The signature timestamp is more than ${toleranceSec} seconds from the server's clock.` };
  }
  for (const secret of secrets) {
    const expected = Buffer.from(sign(secret, parsed.t, body), "hex");
    for (const given of parsed.v1) {
      if (timingSafeEqual(expected, Buffer.from(given, "hex"))) return { ok: true, signature: given, t: parsed.t };
    }
  }
  return { ok: false, code: "bad_signature", message: "The signature doesn't match. Sign the exact bytes you send, with the stream's current secret." };
}

// ------------------------------------------------------------ text hygiene

// C0 controls except tab and newline, DEL, and bidirectional overrides that
// can make text read differently from what it contains.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/g;

export function cleanText(s: string): string {
  return s.replace(/\r\n?/g, "\n").replace(CONTROL, "");
}

export function oneLine(s: string): string {
  return cleanText(s).replace(/\s+/g, " ").trim();
}

/** Backslash-escapes Markdown that could add links, images, HTML or formatting. */
export function escapeMarkdown(s: string): string {
  return s.replace(/[\\`*_[\]<>|~!]/g, "\\$&");
}

/**
 * Stops submitted text from pinging GitHub users or teams (@name) and from
 * cross-referencing other issues (#12, owner/repo#12), by inserting a
 * zero-width space. The text still reads the same.
 */
export function neutralizeMentions(s: string): string {
  return s.replace(/(^|[^\w`])@(?=[A-Za-z0-9])/g, "$1@​").replace(/(^|[^&`])#(?=\d)/g, "$1#​");
}

/** A code fence longer than any run of backticks in the content. */
export function fenced(content: string, lang = ""): string {
  const longest = Math.max(2, ...[...content.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${lang}\n${content}\n${fence}`;
}

/** Deterministic JSON (sorted keys) for hashing payloads. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(",")}}`;
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// ------------------------------------------------------------ payloads

export type Payload = Record<string, unknown>;

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function setPath(obj: Payload, path: string, value: unknown) {
  const parts = path.split(".");
  let cur: Payload = obj;
  for (const part of parts.slice(0, -1)) {
    const next = cur[part];
    if (next === null || typeof next !== "object" || Array.isArray(next)) cur[part] = {};
    cur = cur[part] as Payload;
  }
  cur[parts[parts.length - 1]!] = value;
}

export function deletePath(obj: Payload, path: string) {
  const parts = path.split(".");
  const parent = parts.length > 1 ? getPath(obj, parts.slice(0, -1).join(".")) : obj;
  if (parent && typeof parent === "object" && !Array.isArray(parent)) delete (parent as Payload)[parts[parts.length - 1]!];
}

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/**
 * Copies a parsed body into a plain object, cleaning strings and enforcing
 * structural limits (depth, keys, array length). Returns an error message
 * when the shape is unacceptable.
 */
export function normalizePayload(input: unknown, limits = { depth: 5, keys: 200, array: 100 }): { payload: Payload } | { error: string } {
  let keys = 0;
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") return cleanText(v);
    if (v === null || typeof v === "number" || typeof v === "boolean") return v;
    if (depth >= limits.depth) throw new Error(`The payload is nested more than ${limits.depth} levels deep.`);
    if (Array.isArray(v)) {
      if (v.length > limits.array) throw new Error(`Lists can have at most ${limits.array} items.`);
      return v.map((x) => walk(x, depth + 1));
    }
    if (typeof v === "object") {
      const out: Payload = {};
      for (const [k, x] of Object.entries(v as Payload)) {
        if (FORBIDDEN_KEYS.has(k)) continue;
        if (++keys > limits.keys) throw new Error(`The payload has more than ${limits.keys} fields.`);
        if (k.length > 128) throw new Error("A field name is longer than 128 characters.");
        out[cleanText(k)] = walk(x, depth + 1);
      }
      return out;
    }
    return null;
  };
  if (input === null || typeof input !== "object" || Array.isArray(input)) return { error: "Send a JSON object (or form fields), not a list or a single value." };
  try {
    return { payload: walk(input, 0) as Payload };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/** Form fields → an object. Repeated names become lists; "a.b" names nest. */
export function formToPayload(entries: Iterable<[string, string]>): Payload {
  const out: Payload = {};
  for (const [k, v] of entries) {
    if (FORBIDDEN_KEYS.has(k) || k.split(".").some((p) => FORBIDDEN_KEYS.has(p) || !p)) continue;
    const existing = getPath(out, k);
    if (existing === undefined) setPath(out, k, v);
    else setPath(out, k, Array.isArray(existing) ? [...existing, v] : [existing, v]);
  }
  return out;
}

// ------------------------------------------------------------ fields

export type FieldType = "text" | "long_text" | "email" | "url" | "number" | "boolean" | "choice";

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  maxLength: number;
  options: string[];
  hidden: boolean;
}

export const DEFAULT_MAX: Record<FieldType, number> = { text: 300, long_text: 5000, email: 254, url: 2000, number: 40, boolean: 10, choice: 200 };

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,}$/;

function isEmpty(v: unknown) {
  return v === undefined || v === null || (typeof v === "string" && !v.trim()) || (Array.isArray(v) && !v.length);
}

/** Checks one value against its field. Returns the cleaned value or an error. */
export function coerceField(f: FieldDef, raw: unknown): { value: unknown } | { error: string } {
  const v = Array.isArray(raw) && f.type !== "long_text" ? raw[0] : raw;
  const str = (x: unknown) => (typeof x === "string" ? x : typeof x === "number" || typeof x === "boolean" ? String(x) : Array.isArray(x) ? x.map(String).join("\n") : JSON.stringify(x));
  const max = f.maxLength || DEFAULT_MAX[f.type];
  switch (f.type) {
    case "text": {
      const s = oneLine(str(v));
      return s.length > max ? { error: `can be at most ${max} characters` } : { value: s };
    }
    case "long_text": {
      const s = cleanText(str(v)).trim();
      return s.length > max ? { error: `can be at most ${max} characters` } : { value: s };
    }
    case "email": {
      const s = oneLine(str(v)).toLowerCase();
      return s.length <= max && EMAIL.test(s) ? { value: s } : { error: "should be an email address" };
    }
    case "url": {
      const s = oneLine(str(v));
      try {
        const u = new URL(s);
        if (u.protocol !== "https:" && u.protocol !== "http:") return { error: "should be an http(s) link" };
        return s.length > max ? { error: `can be at most ${max} characters` } : { value: u.toString() };
      } catch {
        return { error: "should be a link starting with https://" };
      }
    }
    case "number": {
      const n = typeof v === "number" ? v : Number(oneLine(str(v)));
      return Number.isFinite(n) ? { value: n } : { error: "should be a number" };
    }
    case "boolean": {
      if (typeof v === "boolean") return { value: v };
      const s = oneLine(str(v)).toLowerCase();
      if (["true", "1", "yes", "on"].includes(s)) return { value: true };
      if (["false", "0", "no", "off"].includes(s)) return { value: false };
      return { error: "should be true or false" };
    }
    case "choice": {
      const s = oneLine(str(v));
      const match = f.options.find((o) => o.toLowerCase() === s.toLowerCase());
      return match !== undefined ? { value: match } : { error: `should be one of: ${f.options.join(", ")}` };
    }
  }
}

/**
 * Validates a payload against the stream's fields. Known fields are replaced
 * by their cleaned values; in strict mode anything else is an error.
 */
export function validateFields(payload: Payload, fields: FieldDef[], strict: boolean, ignore: string[] = []): { payload: Payload; errors: Record<string, string> } {
  const out: Payload = structuredClone(payload);
  const errors: Record<string, string> = {};
  for (const f of fields) {
    const raw = getPath(out, f.key);
    if (isEmpty(raw)) {
      if (f.required) errors[f.key] = `${f.label || f.key} is required`;
      else if (raw !== undefined) deletePath(out, f.key);
      continue;
    }
    const r = coerceField(f, raw);
    if ("error" in r) errors[f.key] = `${f.label || f.key} ${r.error}`;
    else setPath(out, f.key, r.value);
  }
  if (strict) {
    const known = new Set([...fields.map((f) => f.key.split(".")[0]!), ...ignore]);
    for (const k of Object.keys(out)) if (!known.has(k)) errors[k] = `${k} isn't a field this stream accepts`;
  }
  return { payload: out, errors };
}

// ------------------------------------------------------------ templates

export interface TemplateContext {
  payload: Payload;
  fields: FieldDef[];
  stream: { name: string; id: string };
  meta: Record<string, string | null>;
}

export interface RenderOptions {
  /** Applied to every value that came from the submission. */
  escape: (s: string) => string;
}

const TOKEN = /\{\{\s*([A-Za-z0-9_.-]+)\s*(?:\|\s*(upper|lower|trim|json|default)\s*(?::\s*"([^"]{0,200})")?\s*)?\}\}/g;

function stringify(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v) && v.every((x) => typeof x !== "object" || x === null)) return v.map((x) => stringify(x)).join(", ");
  return JSON.stringify(v);
}

// Undeclared fields are labelled by their (submitted) key, so labels get the
// same treatment as values.
const safeLabel = (label: string) => escapeMarkdown(neutralizeMentions(oneLine(label)));

function labelFor(key: string) {
  return key.replace(/[_.-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/** Every submitted field as Markdown: declared fields first, in order, then the rest. */
export function fieldsMarkdown(ctx: TemplateContext, opts: RenderOptions): string {
  const blocks: string[] = [];
  const seen = new Set<string>();
  const add = (label: string, v: unknown, long: boolean) => {
    const text = stringify(v);
    if (!text) return;
    if (long || text.includes("\n")) {
      const quoted = opts
        .escape(text)
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n");
      blocks.push(`**${safeLabel(label)}**\n\n${quoted}`);
    } else {
      blocks.push(`**${safeLabel(label)}:** ${opts.escape(text)}`);
    }
  };
  for (const f of ctx.fields) {
    seen.add(f.key.split(".")[0]!);
    if (f.hidden) continue;
    add(f.label || labelFor(f.key), getPath(ctx.payload, f.key), f.type === "long_text");
  }
  for (const [k, v] of Object.entries(ctx.payload)) {
    if (seen.has(k)) continue;
    add(labelFor(k), v, false);
  }
  return blocks.join("\n\n");
}

/**
 * Fills {{path}} placeholders. Paths read the submission ("title",
 * "user.email"), plus _stream.name, _meta.* (receivedAt, origin, ip, userAgent,
 * referer), _fields (all fields as Markdown) and _json (the submission as a
 * code block). Filters: upper, lower, trim, json, default:"text".
 */
export function render(template: string, ctx: TemplateContext, opts: RenderOptions): string {
  return template.replace(TOKEN, (_m, path: string, filter?: string, arg?: string) => {
    if (path === "_fields") return fieldsMarkdown(ctx, opts);
    if (path === "_json") return fenced(JSON.stringify(ctx.payload, null, 2), "json");
    let value: unknown;
    let trusted = false;
    if (path.startsWith("_stream.")) {
      value = getPath(ctx.stream, path.slice(8));
      trusted = true;
    } else if (path.startsWith("_meta.")) value = ctx.meta[path.slice(6)];
    else value = getPath(ctx.payload, path);
    let s = filter === "json" ? JSON.stringify(value ?? null) : stringify(value);
    if (filter === "upper") s = s.toUpperCase();
    if (filter === "lower") s = s.toLowerCase();
    if (filter === "trim") s = s.trim();
    if (filter === "default" && !s.trim()) return arg ?? "";
    return trusted ? s : opts.escape(s);
  });
}

/** The placeholders a template uses (for previews and warnings). */
export function placeholders(template: string): string[] {
  return [...template.matchAll(TOKEN)].map((m) => m[1]!);
}

// ------------------------------------------------------------ origins and addresses

/** Lower-cased scheme://host[:port], or null when it isn't an http(s) origin. */
export function normalizeOrigin(o: string): string | null {
  try {
    const u = new URL(o.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.origin.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Origin patterns: "https://example.com" (exact), "https://*.example.com"
 * (any subdomain, not the apex), or "*" (anywhere).
 */
export function originAllowed(origin: string | null | undefined, patterns: string[]): boolean {
  if (!origin) return false;
  const o = normalizeOrigin(origin);
  if (!o) return false;
  for (const raw of patterns) {
    const p = raw.trim().toLowerCase().replace(/\/+$/, "");
    if (p === "*") return true;
    if (p.includes("://*.")) {
      const [scheme, rest] = p.split("://*.");
      const u = new URL(o);
      if (`${u.protocol}` === `${scheme}:` && u.host.endsWith(`.${rest}`)) return true;
    } else if (p === o) return true;
  }
  return false;
}

export function validOriginPattern(p: string): boolean {
  const s = p.trim().toLowerCase();
  if (s === "*") return true;
  if (/^https?:\/\/\*\.[a-z0-9.-]+(:\d+)?$/.test(s)) return true;
  return normalizeOrigin(s) === s.replace(/\/+$/, "");
}

/** "::ffff:1.2.3.4" → "1.2.3.4". */
export function normalizeIp(ip: string): string {
  const s = ip.trim();
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s);
  return m ? m[1]! : s;
}

export function validCidr(entry: string): boolean {
  const [addr, prefix] = entry.trim().split("/");
  const kind = isIP(addr ?? "");
  if (!kind) return false;
  if (prefix === undefined) return true;
  const n = Number(prefix);
  return /^\d{1,3}$/.test(prefix) && n >= 0 && n <= (kind === 4 ? 32 : 128);
}

export function ipAllowed(ip: string, entries: string[]): boolean {
  if (!entries.length) return true;
  const addr = normalizeIp(ip);
  const kind = isIP(addr);
  if (!kind) return false;
  const list = new BlockList();
  for (const e of entries) {
    if (!validCidr(e)) continue;
    const [a, p] = e.trim().split("/");
    const t = isIP(a!) === 4 ? "ipv4" : "ipv6";
    if (p === undefined) list.addAddress(a!, t);
    else list.addSubnet(a!, Number(p), t);
  }
  return list.check(addr, kind === 4 ? "ipv4" : "ipv6");
}

// ------------------------------------------------------------ rate windows

/** Fixed-window counters kept in memory (one server process). */
export class RateWindows {
  private m = new Map<string, { n: number; reset: number }>();

  /** Counts a hit; ok is false (with seconds to wait) once over the limit. */
  hit(key: string, limit: number, windowMs: number, now = Date.now()): { ok: boolean; retryAfter: number } {
    let w = this.m.get(key);
    if (!w || w.reset <= now) {
      w = { n: 0, reset: now + windowMs };
      this.m.set(key, w);
    }
    w.n++;
    return w.n <= limit ? { ok: true, retryAfter: 0 } : { ok: false, retryAfter: Math.max(1, Math.ceil((w.reset - now) / 1000)) };
  }

  /** Forgets expired windows. */
  sweep(now = Date.now()) {
    for (const [k, w] of this.m) if (w.reset <= now) this.m.delete(k);
  }

  get size() {
    return this.m.size;
  }
}

/** Remembers values until they expire (signature replay protection). */
export class SeenSet {
  private m = new Map<string, number>();

  /** False when the value was already seen and hasn't expired. */
  add(value: string, expires: number, now = Date.now()): boolean {
    const e = this.m.get(value);
    if (e !== undefined && e > now) return false;
    this.m.set(value, expires);
    if (this.m.size > 50_000) this.sweep(now);
    return true;
  }

  sweep(now = Date.now()) {
    for (const [k, e] of this.m) if (e <= now) this.m.delete(k);
  }
}

/** YYYY-MM-DD for "today plus n days" in a time zone (UTC when unknown). */
export function dateIn(days: number, timeZone: string | null, now = new Date()): string {
  const t = new Date(now.getTime() + days * 86_400_000);
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timeZone || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(t);
  } catch {
    return t.toISOString().slice(0, 10);
  }
}
