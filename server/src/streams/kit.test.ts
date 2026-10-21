import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  dateIn,
  decrypt,
  encrypt,
  escapeMarkdown,
  fenced,
  formToPayload,
  hint,
  ipAllowed,
  neutralizeMentions,
  newSecret,
  newStreamId,
  normalizePayload,
  originAllowed,
  parseSignature,
  RateWindows,
  render,
  safeEqual,
  SeenSet,
  sign,
  STREAM_ID,
  uuidv7,
  validateFields,
  validCidr,
  validOriginPattern,
  verifySignature,
  type FieldDef,
  type TemplateContext,
} from "./kit.js";
import { mergeConfig, PRESETS, streamConfig } from "./schema.js";

const field = (f: Partial<FieldDef> & { key: string }): FieldDef => ({ label: "", type: "text", required: false, maxLength: 0, options: [], hidden: false, ...f });

describe("identifiers", () => {
  it("makes 64-hex stream ids and kss_ secrets", () => {
    expect(newStreamId()).toMatch(STREAM_ID);
    const s = newSecret();
    expect(s).toMatch(/^kss_[A-Za-z0-9_-]{43}$/);
    expect(hint(s)).toBe(`kss_…${s.slice(-4)}`);
    expect(hint("github_pat_abcdef1234")).toBe("github_pat_…1234");
    // A secret whose own characters look like another prefix must not have
    // them shown: only "kss_" is the prefix here.
    expect(hint("kss_ARsYLFO_Qk2mXXuU")).toBe("kss_…XXuU");
  });

  it("makes time-ordered v7 UUIDs", () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });
});

describe("encryption", () => {
  const key = randomBytes(32);
  it("round-trips and binds to its associated data", () => {
    const blob = encrypt(key, "ghp_secret", "abc:github");
    expect(blob.startsWith("v1.")).toBe(true);
    expect(decrypt(key, blob, "abc:github")).toBe("ghp_secret");
    expect(() => decrypt(key, blob, "abc:secret")).toThrow();
    expect(() => decrypt(randomBytes(32), blob, "abc:github")).toThrow();
  });

  it("compares in constant time", () => {
    expect(safeEqual("kss_a", "kss_a")).toBe(true);
    expect(safeEqual("kss_a", "kss_b")).toBe(false);
    expect(safeEqual("kss_a", "kss_aa")).toBe(false);
  });
});

describe("signatures", () => {
  const body = new TextEncoder().encode('{"title":"Hi"}');
  const secret = newSecret();
  const now = 1_800_000_000;

  it("accepts a fresh signature from any active secret", () => {
    const header = `t=${now},v1=${sign(secret, now, body)}`;
    expect(verifySignature(header, ["kss_other", secret], body, now + 10, 300).ok).toBe(true);
  });

  it("rejects stale, tampered and malformed signatures", () => {
    const header = `t=${now},v1=${sign(secret, now, body)}`;
    expect(verifySignature(header, [secret], body, now + 301, 300)).toMatchObject({ ok: false, code: "stale_signature" });
    expect(verifySignature(header, [secret], new TextEncoder().encode('{"title":"Hello"}'), now, 300)).toMatchObject({ ok: false, code: "bad_signature" });
    expect(verifySignature("v1=abc", [secret], body, now, 300)).toMatchObject({ ok: false, code: "malformed_signature" });
    expect(verifySignature(null, [secret], body, now, 300)).toMatchObject({ ok: false, code: "missing_signature" });
  });

  it("parses several v1 values", () => {
    const a = "a".repeat(64);
    const b = "B".repeat(64);
    expect(parseSignature(`t=5, v1=${a}, v1=${b}`)).toEqual({ t: 5, v1: [a, b.toLowerCase()] });
  });
});

describe("text hygiene", () => {
  it("escapes Markdown that could add links, images or HTML", () => {
    expect(escapeMarkdown("[click](http://x) ![i](y) <b>*hi*</b>")).toBe("\\[click\\](http://x) \\!\\[i\\](y) \\<b\\>\\*hi\\*\\</b\\>");
  });

  it("neutralises mentions and issue references", () => {
    const out = neutralizeMentions("cc @octocat and @org/team, see #12 and a/b#3; email a@b.co");
    expect(out).toContain("@​octocat");
    expect(out).toContain("@​org/team");
    expect(out).toContain("#​12");
    expect(out).toContain("a/b#​3");
    expect(out).toContain("a@b.co");
  });

  it("fences content containing backticks", () => {
    expect(fenced("a ``` b")).toBe("````\na ``` b\n````");
  });
});

describe("payloads", () => {
  it("nests dotted form names, collects repeats and refuses prototype keys", () => {
    const p = formToPayload([
      ["user.email", "a@b.co"],
      ["tag", "x"],
      ["tag", "y"],
      ["__proto__.polluted", "1"],
      ["constructor", "1"],
    ]);
    expect(p).toEqual({ user: { email: "a@b.co" }, tag: ["x", "y"] });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("cleans control characters and enforces depth", () => {
    const r = normalizePayload({ t: "a\u0000b‮c\r\nd" });
    expect(r).toEqual({ payload: { t: "abc\nd" } });
    expect(normalizePayload({ a: { b: { c: { d: { e: { f: 1 } } } } } })).toHaveProperty("error");
    expect(normalizePayload([1, 2])).toHaveProperty("error");
  });
});

describe("fields", () => {
  const fields = [
    field({ key: "title", label: "Summary", required: true, maxLength: 10 }),
    field({ key: "severity", type: "choice", options: ["low", "High"] }),
    field({ key: "email", type: "email" }),
    field({ key: "page", type: "url" }),
    field({ key: "count", type: "number" }),
    field({ key: "agree", type: "boolean" }),
  ];

  it("cleans valid values", () => {
    const r = validateFields({ title: " Hi\nthere ", severity: "high", email: "A@B.CO", page: "https://x.dev/a", count: "3", agree: "on", extra: 1 }, fields, false);
    expect(r.errors).toEqual({});
    expect(r.payload).toEqual({ title: "Hi there", severity: "High", email: "a@b.co", page: "https://x.dev/a", count: 3, agree: true, extra: 1 });
  });

  it("reports problems", () => {
    const r = validateFields({ severity: "meh", email: "nope", page: "javascript:alert(1)", count: "x", extra: 1 }, fields, true);
    expect(Object.keys(r.errors).sort()).toEqual(["count", "email", "extra", "page", "severity", "title"]);
    expect(r.errors.title).toBe("Summary is required");
    expect(validateFields({ title: "far too long here" }, fields, false).errors.title).toMatch(/at most 10/);
  });
});

describe("templates", () => {
  const ctx: TemplateContext = {
    payload: { title: "Crash [here](http://evil)", user: { email: "a@b.co" }, notes: "line 1\nline 2", n: 2 },
    fields: [field({ key: "title", label: "Title" }), field({ key: "notes", label: "Notes", type: "long_text" })],
    stream: { id: "x", name: "Bugs_*" },
    meta: { origin: "https://site.dev" },
  };

  it("fills placeholders, escaping only submitted values", () => {
    const out = render("{{_stream.name}}: {{title}} by {{user.email}} ({{missing | default:\"none\"}}) {{n | json}} {{_meta.origin}}", ctx, { escape: escapeMarkdown });
    expect(out).toBe('Bugs_*: Crash \\[here\\](http://evil) by a@b.co (none) 2 https://site.dev');
  });

  it("lists every field, quoting long text", () => {
    const out = render("{{_fields}}", ctx, { escape: (s) => s });
    expect(out).toContain("**Title:** Crash [here](http://evil)");
    expect(out).toContain("**Notes**\n\n> line 1\n> line 2");
    expect(out).toContain("**User:**");
    expect(out.indexOf("Title")).toBeLessThan(out.indexOf("User"));
  });
});

describe("origins and addresses", () => {
  it("matches exact, wildcard and any origins", () => {
    expect(originAllowed("https://example.com", ["https://example.com/"])).toBe(true);
    expect(originAllowed("https://EXAMPLE.com", ["https://example.com"])).toBe(true);
    expect(originAllowed("http://example.com", ["https://example.com"])).toBe(false);
    expect(originAllowed("https://app.example.com", ["https://*.example.com"])).toBe(true);
    expect(originAllowed("https://example.com", ["https://*.example.com"])).toBe(false);
    expect(originAllowed("https://evilexample.com", ["https://*.example.com"])).toBe(false);
    expect(originAllowed("https://x.dev", ["*"])).toBe(true);
    expect(originAllowed(null, ["*"])).toBe(false);
    expect(validOriginPattern("https://*.example.com")).toBe(true);
    expect(validOriginPattern("http://localhost:3000")).toBe(true);
    expect(validOriginPattern("example.com")).toBe(false);
    expect(validOriginPattern("https://example.com/path")).toBe(false);
  });

  it("checks IPv4, IPv6 and mapped addresses against CIDR ranges", () => {
    expect(ipAllowed("1.2.3.4", [])).toBe(true);
    expect(ipAllowed("203.0.113.9", ["203.0.113.0/24"])).toBe(true);
    expect(ipAllowed("::ffff:203.0.113.9", ["203.0.113.0/24"])).toBe(true);
    expect(ipAllowed("198.51.100.1", ["203.0.113.0/24"])).toBe(false);
    expect(ipAllowed("2001:db8::1", ["2001:db8::/32"])).toBe(true);
    expect(ipAllowed("10.0.0.1", ["10.0.0.1"])).toBe(true);
    expect(validCidr("10.0.0.0/33")).toBe(false);
    expect(validCidr("nope")).toBe(false);
  });
});

describe("rate windows", () => {
  it("allows up to the limit per window", () => {
    const w = new RateWindows();
    expect(w.hit("k", 2, 1000, 0).ok).toBe(true);
    expect(w.hit("k", 2, 1000, 1).ok).toBe(true);
    expect(w.hit("k", 2, 1000, 2)).toEqual({ ok: false, retryAfter: 1 });
    expect(w.hit("k", 2, 1000, 1001).ok).toBe(true);
    w.sweep(5000);
    expect(w.size).toBe(0);
  });

  it("remembers values until they expire", () => {
    const s = new SeenSet();
    expect(s.add("sig", 100, 0)).toBe(true);
    expect(s.add("sig", 100, 50)).toBe(false);
    expect(s.add("sig", 200, 150)).toBe(true);
  });
});

describe("dates", () => {
  it("counts days in the space's time zone", () => {
    const at = new Date("2026-10-13T23:30:00Z");
    expect(dateIn(0, "UTC", at)).toBe("2026-10-13");
    expect(dateIn(0, "Asia/Tokyo", at)).toBe("2026-10-14");
    expect(dateIn(7, null, at)).toBe("2026-10-20");
    expect(dateIn(0, "Not/AZone", at)).toBe("2026-10-13");
  });
});

describe("config", () => {
  it("fills every default from an empty object", () => {
    const c = streamConfig.parse({});
    expect(c.action).toBe("task");
    expect(c.security.auth).toBe("public");
    expect(c.security.rateLimit.perMinute).toBe(5);
    expect(c.log.retentionDays).toBe(30);
  });

  it("merges updates deeply but replaces lists and the priority map", () => {
    const base = streamConfig.parse({ task: { priorityMap: { a: 1, b: 2 }, labelIds: ["x"] } });
    const merged = streamConfig.parse(mergeConfig(base, { task: { priorityMap: { c: 3 }, labelIds: [] }, security: { rateLimit: { perHour: 9 } } }));
    expect(merged.task.priorityMap).toEqual({ c: 3 });
    expect(merged.task.labelIds).toEqual([]);
    expect(merged.security.rateLimit).toMatchObject({ perHour: 9, perMinute: 5 });
  });

  it("rejects bad settings", () => {
    expect(streamConfig.safeParse({ security: { allowedOrigins: ["example.com"] } }).success).toBe(false);
    expect(streamConfig.safeParse({ fields: { list: [{ key: "a" }, { key: "a" }] } }).success).toBe(false);
    expect(streamConfig.safeParse({ fields: { list: [{ key: "s", type: "choice" }] } }).success).toBe(false);
    expect(streamConfig.safeParse({ github: { repo: "not a repo" } }).success).toBe(false);
  });

  it("has valid presets", () => {
    for (const [id, p] of Object.entries(PRESETS)) expect(streamConfig.safeParse(p.config).success, id).toBe(true);
  });
});
