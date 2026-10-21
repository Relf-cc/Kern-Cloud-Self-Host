/**
 * @Author Christian Relf
 * @Date 2026-10-21
 */

import { describe, expect, it } from "vitest";
import { ago, bytes, duration, host, shorten } from "./format";

describe("byte counts", () => {
  it("reads the way a person would say it", () => {
    expect(bytes(0)).toBe("0 B");
    expect(bytes(512)).toBe("512 B");
    expect(bytes(1536)).toBe("1.5 KB");
    expect(bytes(183500800)).toBe("175 MB");
    expect(bytes(1024 ** 4)).toBe("1.0 TB");
  });

  it("doesn't invent a number it hasn't got", () => {
    expect(bytes(Number.NaN)).toBe("-");
    expect(bytes(-1)).toBe("-");
  });
});

describe("uptime", () => {
  it("loses the precision nobody needs", () => {
    expect(duration(30)).toBe("30s");
    expect(duration(90)).toBe("1m");
    expect(duration(3660)).toBe("1h 1m");
    expect(duration(93784)).toBe("1d 2h");
  });
});

describe("how long ago", () => {
  const now = Date.parse("2026-10-21T12:00:00.000Z");

  it("says never when there is no time at all", () => {
    expect(ago(null, now)).toBe("never");
    expect(ago("not a date", now)).toBe("never");
  });

  it("gets coarser as it gets further away", () => {
    expect(ago("2026-10-21T11:59:50.000Z", now)).toBe("just now");
    expect(ago("2026-10-21T11:30:00.000Z", now)).toBe("30 minutes ago");
    expect(ago("2026-10-21T06:00:00.000Z", now)).toBe("6 hours ago");
    expect(ago("2026-10-18T12:00:00.000Z", now)).toBe("3 days ago");
    expect(ago("2026-08-21T12:00:00.000Z", now)).toBe("2 months ago");
  });

  it("reads forwards too, for anything that expires", () => {
    expect(ago("2026-11-04T12:00:00.000Z", now)).toBe("in 14 days");
    expect(ago("2026-10-21T13:00:00.000Z", now)).toBe("in 1 hour");
  });
});

describe("addresses and ids", () => {
  it("takes the host out of an API base", () => {
    expect(host("http://127.0.0.1:8787/kern/v1")).toBe("127.0.0.1:8787");
    expect(host("https://kern.example.com/kern/v1")).toBe("kern.example.com");
    // Anything unparseable comes back as it was, rather than as "undefined".
    expect(host("not a url")).toBe("not a url");
  });

  it("shortens a long id without hiding a short one", () => {
    expect(shorten("a".repeat(64))).toBe(`${"a".repeat(8)}…aaaa`);
    expect(shorten("short")).toBe("short");
  });
});
