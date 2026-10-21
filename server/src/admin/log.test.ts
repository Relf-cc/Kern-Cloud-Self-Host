import { describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({ config: { admin: { logLines: 5 } } }));

const { redact } = await import("./log.js");

describe("what never leaves in a log line", () => {
  it("removes a management token", () => {
    const token = `kern_0123456789abcdef_${"A".repeat(43)}`;
    expect(redact(`[admin] rejected ${token}`)).toBe("[admin] rejected kern_<token>");
  });

  it("removes the password from a database URL", () => {
    expect(redact("postgres://kern:s3cret-pw@db:5432/kern")).toBe("postgres://kern:<password>@db:5432/kern");
    expect(redact("postgresql://kern:p@db/kern")).toBe("postgresql://kern:<password>@db/kern");
  });

  it("removes anything presented as a secret", () => {
    expect(redact("BETTER_AUTH_SECRET=abc123xyz")).toBe("BETTER_AUTH_SECRET=<redacted>");
    expect(redact("github_token: ghp_aaaabbbb")).toBe("github_token: <redacted>");
    expect(redact("api_key = live_123")).toBe("api_key = <redacted>");
  });

  it("removes one-time codes, which are emailed in plain text", () => {
    expect(redact("[mail] (console) code: 402913")).toBe("[mail] (console) code: <code>");
    // Not every number is a code: longer runs are left alone.
    expect(redact("pruned 1234567 rows")).toBe("pruned 1234567 rows");
  });

  it("leaves ordinary lines alone", () => {
    const line = "[kern] Acme Labs listening on http://[::]:8787/kern/v1";
    expect(redact(line)).toBe(line);
  });
});
