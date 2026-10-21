import { describe, expect, it } from "vitest";
import { addressAllowed, isLoopback, matches } from "./reach.js";

const POLICY = { localOnly: false, allowFrom: ["10.0.0.0/8", "192.168.1.5"] };
const LOCAL_ONLY = { localOnly: true, allowFrom: ["10.0.0.0/8"] };

describe("where the management API answers", () => {
  it("knows loopback in both families, and through an IPv4-mapped address", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("127.1.2.3")).toBe(true);
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopback("10.0.0.1")).toBe(false);
    // A public address that merely starts with the same digits isn't loopback.
    expect(isLoopback("12.7.0.1")).toBe(false);
  });

  it("matches a plain address exactly", () => {
    expect(matches("192.168.1.5", "192.168.1.5")).toBe(true);
    expect(matches("192.168.1.6", "192.168.1.5")).toBe(false);
  });

  it("matches a CIDR range by its prefix", () => {
    expect(matches("10.4.5.6", "10.0.0.0/8")).toBe(true);
    expect(matches("11.4.5.6", "10.0.0.0/8")).toBe(false);
    expect(matches("192.168.1.200", "192.168.1.0/24")).toBe(true);
    expect(matches("192.168.2.1", "192.168.1.0/24")).toBe(false);
    expect(matches("8.8.8.8", "0.0.0.0/0")).toBe(true);
  });

  it("refuses a rule it can't evaluate rather than guessing", () => {
    expect(matches("10.0.0.1", "10.0.0.0/33")).toBe(false);
    expect(matches("10.0.0.1", "10.0.0.0/nonsense")).toBe(false);
    expect(matches("10.0.0.1", "")).toBe(false);
    // IPv6 prefixes aren't implemented; a half-right match would be worse.
    expect(matches("fd00::1", "fd00::/8")).toBe(false);
  });

  it("allows loopback always, and the allow list when it isn't loopback-only", () => {
    expect(addressAllowed("127.0.0.1", POLICY)).toBe(true);
    expect(addressAllowed("10.9.9.9", POLICY)).toBe(true);
    expect(addressAllowed("192.168.1.5", POLICY)).toBe(true);
    expect(addressAllowed("192.168.1.6", POLICY)).toBe(false);
    expect(addressAllowed(null, POLICY)).toBe(false);
  });

  it("ignores the allow list while it is loopback-only", () => {
    expect(addressAllowed("127.0.0.1", LOCAL_ONLY)).toBe(true);
    expect(addressAllowed("::ffff:127.0.0.1", LOCAL_ONLY)).toBe(true);
    expect(addressAllowed("10.9.9.9", LOCAL_ONLY)).toBe(false);
  });
});
