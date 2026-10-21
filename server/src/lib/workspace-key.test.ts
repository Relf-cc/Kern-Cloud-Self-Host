import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fingerprint, looksLikeKey } from "./workspace-key.js";

const hex32 = "a".repeat(32);
const real = `k_${hex32}`;

describe("looksLikeKey", () => {
  it("accepts k_ followed by 32 lowercase hex", () => {
    expect(looksLikeKey(real)).toBe(true);
    expect(looksLikeKey("k_7f3a9c2e14b85d06a1f4e8c93b2d7a50")).toBe(true);
  });

  it("tolerates surrounding whitespace, because people paste", () => {
    expect(looksLikeKey(`  ${real}\n`)).toBe(true);
  });

  it("refuses the wrong length", () => {
    expect(looksLikeKey(`k_${"a".repeat(31)}`)).toBe(false);
    expect(looksLikeKey(`k_${"a".repeat(33)}`)).toBe(false);
  });

  it("refuses non-hex and uppercase", () => {
    expect(looksLikeKey(`k_${"g".repeat(32)}`)).toBe(false);
    expect(looksLikeKey(`k_${"A".repeat(32)}`)).toBe(false);
  });

  it("refuses a missing or wrong prefix", () => {
    expect(looksLikeKey(hex32)).toBe(false);
    expect(looksLikeKey(`K_${hex32}`)).toBe(false);
    expect(looksLikeKey(`kern_${hex32}`)).toBe(false);
  });

  it("refuses a management token, which is a different thing entirely", () => {
    expect(looksLikeKey("kern_0123456789abcdef_" + "x".repeat(43))).toBe(false);
  });

  it("refuses empty input", () => {
    expect(looksLikeKey("")).toBe(false);
    expect(looksLikeKey("   ")).toBe(false);
  });
});

describe("fingerprint", () => {
  it("is the SHA-256 of the whole key, with the id its first 8 hex", () => {
    const fp = fingerprint(real)!;
    const expected = createHash("sha256").update(real).digest("hex");
    expect(fp.hash).toBe(expected);
    expect(fp.id).toBe(expected.slice(0, 8));
    expect(fp.id).toMatch(/^[0-9a-f]{8}$/);
  });

  it("never contains the key itself, so a leaked table yields nothing", () => {
    const fp = fingerprint(real)!;
    expect(fp.hash).not.toContain(hex32);
    expect(fp.id).not.toContain(hex32);
  });

  it("is stable across calls and ignores surrounding whitespace", () => {
    expect(fingerprint(real)).toEqual(fingerprint(`\t${real}  `));
  });

  it("differs for keys that differ by one character", () => {
    const a = fingerprint(`k_${"a".repeat(32)}`)!;
    const b = fingerprint(`k_${"a".repeat(31)}b`)!;
    expect(a.hash).not.toBe(b.hash);
    expect(a.id).not.toBe(b.id);
  });

  it("returns null for anything not shaped like a key", () => {
    expect(fingerprint("")).toBeNull();
    expect(fingerprint(hex32)).toBeNull();
    expect(fingerprint(`k_${"A".repeat(32)}`)).toBeNull();
    expect(fingerprint("kern_0123456789abcdef_" + "x".repeat(43))).toBeNull();
  });
});
