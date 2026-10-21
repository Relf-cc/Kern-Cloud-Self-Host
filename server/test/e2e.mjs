// End-to-end check of the Kern Cloud API against a running server whose
// emails go to its log (SMTP_HOST unset). Usage:
//   npm run dev > server.log 2>&1 &   then   node test/e2e.mjs server.log
import { readFileSync } from "node:fs";

const ORIGIN = process.env.KERN_TEST_ORIGIN ?? "http://localhost:8787";
const BASE = `${ORIGIN}/kern/v1`;
const LOG = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${msg}`);
  if (!cond) failures++;
};

async function call(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: { origin: ORIGIN, "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json, headers: res.headers };
}

async function otpFor(email, kind) {
  for (let i = 0; i < 20; i++) {
    const log = readFileSync(LOG, "utf8");
    const blocks = log.split("[mail] (console) ").filter((b) => b.startsWith(`to=${email} `) && b.includes(kind));
    const last = blocks.at(-1);
    const m = last?.match(/Code: (\d{6})/);
    if (m) return m[1];
    await sleep(250);
  }
  throw new Error(`no OTP for ${email}`);
}

async function account(name) {
  const email = `${name.toLowerCase()}-${Date.now()}@example.com`;
  const up = await call("POST", "/auth/sign-up/email", { name, email, password: "correct horse battery" });
  ok(up.status === 200, `${name} signs up (${up.status})`);
  const signin = await call("POST", "/auth/sign-in/email", { email, password: "correct horse battery" });
  ok(signin.status === 403, `${name} unverified sign-in is refused (${signin.status})`);
  const code = await otpFor(email, "verification code");
  const v = await call("POST", "/auth/email-otp/verify-email", { email, otp: code });
  const token = v.headers.get("set-auth-token") ?? v.json.token;
  ok(v.status === 200 && !!token, `${name} verifies with emailed code and gets a token`);
  return { email, token, name };
}

const A = await account("Ada");
const B = await account("Bob");

const me = await call("GET", "/me", null, A.token);
ok(me.status === 200 && me.json.user.email === A.email && me.json.personal === null, "GET /me works with bearer token");

const personal = await call("POST", "/me/personal", null, A.token);
ok(personal.status === 200 && personal.json.kind === "personal", "personal space is created");

// Workspace with an invite for B.
const ws = await call(
  "POST",
  "/workspaces",
  { name: "Acme Labs", description: "Test", teamSize: "2-10", industry: "Software", timezone: "Europe/London", githubOrg: "acme", invites: [{ email: B.email, role: "member" }], inviteMessage: "Join us" },
  A.token,
);
ok(ws.status === 201 && /^acme-labs(-\d+)?$/.test(ws.json.workspace.slug), `workspace created with slug (${ws.json.workspace?.slug})`);
ok(ws.json.invites?.[0]?.ok === true, "invite emailed");
const spaceId = ws.json.workspace.id;
const inviteId = ws.json.invites[0].invite.id;

const bMe = await call("GET", "/me", null, B.token);
ok(bMe.json.invites.some((i) => i.id === inviteId), "invitee sees pending invite");

const pub = await call("GET", `/invites/${inviteId}`);
ok(pub.status === 200 && pub.json.workspace === "Acme Labs" && pub.json.status === "pending", "public invite summary");

const page = await fetch(`${ORIGIN}/kern/invite/${inviteId}`);
const html = await page.text();
ok(page.status === 200 && html.includes(`kern://invite/${inviteId}`), "invite link hands off to kern:// scheme");

const notYet = await call("GET", `/spaces/${spaceId}/sync/pull?since=0`, null, B.token);
ok(notYet.status === 404, "non-member can't read the workspace");

const acc = await call("POST", `/invites/${inviteId}/accept`, null, B.token);
ok(acc.status === 200 && acc.json.role === "member", "invitee accepts");

// Realtime: B subscribes, A pushes.
const ticket = await call("POST", "/realtime/ticket", null, B.token);
const sock = new WebSocket(`${ORIGIN.replace(/^http/, "ws")}/kern/v1/realtime?ticket=${ticket.json.ticket}`);
const inbox = [];
sock.onmessage = (e) => inbox.push(JSON.parse(e.data));
await new Promise((r) => (sock.onopen = r));
sock.send(JSON.stringify({ type: "subscribe", space: spaceId }));
await sleep(200);
ok(inbox.some((m) => m.type === "subscribed" && m.space === spaceId), "socket subscribes to space");

const reuse = new WebSocket(`${ORIGIN.replace(/^http/, "ws")}/kern/v1/realtime?ticket=${ticket.json.ticket}`);
const reused = await new Promise((r) => {
  reuse.onopen = () => r("open");
  reuse.onerror = () => r("error");
});
ok(reused === "error", "a ticket can only be used once");

const push = await call(
  "POST",
  `/spaces/${spaceId}/sync/push`,
  {
    changes: [
      { t: "projects", id: "p1", op: "upsert", full: true, data: { id: "p1", name: "Website", description: "", created_at: 1, updated_at: 1 } },
      { t: "tasks", id: "t1", op: "upsert", full: true, data: { id: "t1", title: "Ship", status: "todo", priority: 0, project_id: "p1", created_at: 1, updated_at: 1 } },
    ],
  },
  A.token,
);
ok(push.status === 200 && push.json.from === 1 && push.json.to === 2, `push assigns contiguous seqs (${push.json.from}-${push.json.to})`);
await sleep(200);
const live = inbox.find((m) => m.type === "changes");
ok(live && live.from === 1 && live.changes.length === 2, "subscriber receives changes in realtime");

// Field-level merge: A edits title, B edits status concurrently.
await call("POST", `/spaces/${spaceId}/sync/push`, { changes: [{ t: "tasks", id: "t1", op: "upsert", data: { title: "Ship it" } }] }, A.token);
await call("POST", `/spaces/${spaceId}/sync/push`, { changes: [{ t: "tasks", id: "t1", op: "upsert", data: { status: "in_progress" } }] }, B.token);
const pull = await call("GET", `/spaces/${spaceId}/sync/pull?since=0`, null, B.token);
const t1 = pull.json.changes.find((c) => c.id === "t1");
ok(t1.data.title === "Ship it" && t1.data.status === "in_progress" && t1.data.project_id === "p1", "concurrent field edits merge");
ok(pull.json.cursor === pull.json.head && pull.json.head === 4, `pull cursor reaches head (${pull.json.cursor})`);

// Delete wins over a later partial patch.
await call("POST", `/spaces/${spaceId}/sync/push`, { changes: [{ t: "tasks", id: "t1", op: "delete" }] }, A.token);
const stale = await call("POST", `/spaces/${spaceId}/sync/push`, { changes: [{ t: "tasks", id: "t1", op: "upsert", data: { title: "zombie" } }] }, B.token);
ok(stale.json.rejected.length === 1 && stale.json.changes.length === 0, "patch to a deleted record is rejected");
const inc = await call("GET", `/spaces/${spaceId}/sync/pull?since=4`, null, B.token);
ok(inc.json.changes.length === 1 && inc.json.changes[0].op === "delete", "incremental pull includes tombstone");

const bad = await call("POST", `/spaces/${spaceId}/sync/push`, { changes: [{ t: "settings", id: "x", op: "upsert", data: {} }] }, A.token);
ok(bad.status === 400, "device-local tables are refused");

// Shared whiteboard images.
const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");
const upload = async (bytes, type, token) => {
  const r = await fetch(`${BASE}/spaces/${spaceId}/assets?w=1&h=1`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": type }, body: bytes });
  return { status: r.status, json: await r.json() };
};
const up = await upload(png, "image/png", A.token);
ok(up.status === 201 && !!up.json.id, "image uploads");
const dupe = await upload(png, "image/png", B.token);
ok(dupe.json.id === up.json.id && dupe.json.existing === true, "identical images are stored once per space");
const fake = await upload(Buffer.from("<svg onload=alert(1)>"), "image/png", A.token);
ok(fake.status === 400, "non-images are refused");
const dl = await fetch(`${BASE}/spaces/${spaceId}/assets/${up.json.id}`, { headers: { authorization: `Bearer ${B.token}` } });
const got = Buffer.from(await dl.arrayBuffer());
ok(dl.status === 200 && dl.headers.get("content-type") === "image/png" && got.equals(png), "members download the shared image");
const anon = await fetch(`${BASE}/spaces/${spaceId}/assets/${up.json.id}`);
ok(anon.status === 401, "images need a session");

// Roles.
await call("PATCH", `/workspaces/${spaceId}/members/${bMe.json.user.id}`, { role: "viewer" }, A.token);
const viewerPush = await call("POST", `/spaces/${spaceId}/sync/push`, { changes: [{ t: "notes", id: "n1", op: "upsert", full: true, data: { id: "n1" } }] }, B.token);
ok(viewerPush.status === 403, "viewers can't push");
const bDemote = await call("DELETE", `/workspaces/${spaceId}/members/${me.json.user.id}`, null, B.token);
ok(bDemote.status === 403, "non-admin can't remove the owner");

const detail = await call("GET", `/workspaces/${spaceId}`, null, A.token);
ok(detail.json.members.length === 2, "workspace detail lists members");

// Password recovery.
await call("POST", "/auth/email-otp/request-password-reset", { email: A.email });
const rcode = await otpFor(A.email, "Recover your account");
const reset = await call("POST", "/auth/email-otp/reset-password", { email: A.email, otp: rcode, password: "new password 123" });
ok(reset.status === 200, "password reset with emailed code");
const old = await call("GET", "/me", null, A.token);
ok(old.status === 401, "old sessions are revoked after reset");
const again = await call("POST", "/auth/sign-in/email", { email: A.email, password: "new password 123" });
ok(again.status === 200 && !!again.headers.get("set-auth-token"), "sign in with new password");

sock.close();
reuse.close();
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
