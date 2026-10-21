import { describe, expect, it } from "vitest";
import { isListed } from "./owner.js";

const LIST = ["christianjamesrelf@gmail.com", "ops@relf.cc"];

describe("isListed", () => {
  it("accepts an address on the list", () => {
    expect(isListed("christianjamesrelf@gmail.com", LIST)).toBe(true);
    expect(isListed("ops@relf.cc", LIST)).toBe(true);
  });

  it("ignores case on both sides, because .env is typed by hand", () => {
    expect(isListed("Christian James Relf@gmail.com".replace(/ /g, ""), LIST)).toBe(true);
    expect(isListed("OPS@RELF.CC", LIST)).toBe(true);
    expect(isListed("ops@relf.cc", ["OPS@Relf.CC"])).toBe(true);
  });

  it("ignores surrounding whitespace on both sides", () => {
    expect(isListed("  ops@relf.cc\n", LIST)).toBe(true);
    expect(isListed("ops@relf.cc", [" ops@relf.cc "])).toBe(true);
  });

  it("refuses an address that is not on the list", () => {
    expect(isListed("someone@relf.cc", LIST)).toBe(false);
    expect(isListed("christianjamesrelf@gmail.co", LIST)).toBe(false);
  });

  it("does not match a domain or a wildcard", () => {
    expect(isListed("anyone@relf.cc", ["@relf.cc"])).toBe(false);
    expect(isListed("anyone@relf.cc", ["*@relf.cc"])).toBe(false);
    expect(isListed("anyone@relf.cc", ["relf.cc"])).toBe(false);
  });

  it("refuses a substring or superstring of a listed address", () => {
    expect(isListed("ops@relf.cc.evil.example", LIST)).toBe(false);
    expect(isListed("xops@relf.cc", LIST)).toBe(false);
    expect(isListed("ops@relf.c", LIST)).toBe(false);
  });

  it("refuses empty, blank and missing input", () => {
    expect(isListed("", LIST)).toBe(false);
    expect(isListed("   ", LIST)).toBe(false);
    expect(isListed(null, LIST)).toBe(false);
    expect(isListed(undefined, LIST)).toBe(false);
  });

  it("refuses everything when the list is empty, which is the default", () => {
    expect(isListed("christianjamesrelf@gmail.com", [])).toBe(false);
    expect(isListed("", [])).toBe(false);
  });
});
