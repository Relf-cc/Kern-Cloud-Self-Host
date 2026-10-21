// Creates two verified users sharing a workspace on the local server and
// prints their tokens and the space id (for the Rust sync integration test).
import { readFileSync } from "node:fs";

const ORIGIN = process.env.KERN_TEST_ORIGIN ?? "http://localhost:8787";
const BASE = `${ORIGIN}/kern/v1`;
const LOG = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: { origin: ORIGIN, "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (res.status >= 400) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return { json, headers: res.headers };
}

async function otpFor(email) {
  for (let i = 0; i < 40; i++) {
    const blocks = readFileSync(LOG, "utf8").split("[mail] (console) ").filter((b) => b.startsWith(`to=${email} `));
    const m = blocks.at(-1)?.match(/Code: (\d{6})/);
    if (m) return m[1];
    await sleep(250);
  }
  throw new Error("no otp");
}

async function user(name) {
  const email = `${name}-${Date.now()}@example.com`;
  await call("POST", "/auth/sign-up/email", { name, email, password: "correct horse battery" });
  const v = await call("POST", "/auth/email-otp/verify-email", { email, otp: await otpFor(email) });
  return { email, token: v.headers.get("set-auth-token") };
}

const a = await user("rust-a");
const b = await user("rust-b");
const ws = await call("POST", "/workspaces", { name: `Sync test ${Date.now()}`, invites: [{ email: b.email, role: "member" }] }, a.token);
await call("POST", `/invites/${ws.json.invites[0].invite.id}/accept`, null, b.token);
console.log(JSON.stringify({ a: a.token, b: b.token, space: ws.json.workspace.id }));
