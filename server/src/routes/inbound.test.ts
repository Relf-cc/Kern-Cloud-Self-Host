import { describe, expect, it, vi } from "vitest";

// The route module reads configuration and the database at import time.
vi.mock("../config.js", () => ({ config: { basePath: "/kern/v1", inboundEmail: { secret: "", domain: "in.example" }, limits: { emailHourly: 10 } } }));
vi.mock("../db.js", () => ({ one: vi.fn(), query: vi.fn(), tx: vi.fn() }));
vi.mock("../streams/deliver.js", () => ({ deliver: vi.fn(), logRejection: vi.fn() }));
vi.mock("../streams/store.js", () => ({ configOf: vi.fn(), senderHash: vi.fn() }));

const { address, aliasOf } = await import("./inbound.js");

describe("inbound email addresses", () => {
  it("reads the sender from display-name forms", () => {
    expect(address("Ana Li <Ana@Example.com>")).toBe("ana@example.com");
    expect(address("bo@example.com")).toBe("bo@example.com");
    expect(address("nobody")).toBeNull();
  });

  it("finds the stream alias on the inbound domain only", () => {
    const alias = "abcdefghij0123456789";
    expect(aliasOf(`${alias}@in.example`, "in.example")).toBe(alias);
    expect(aliasOf(`Inbox <${alias}+receipts@IN.example>`, "in.example")).toBe(alias);
    expect(aliasOf(`${alias}@elsewhere.example`, "in.example")).toBeNull();
    expect(aliasOf("short@in.example", "in.example")).toBeNull();
  });
});
