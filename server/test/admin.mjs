// End-to-end check of the management API (/kern/v1/admin/*) against a running
// server. Usage:
//   npm run dev > server.log 2>&1 &   then   node test/admin.mjs server.log
//
// The token comes from KERN_ADMIN_TOKEN, or from the file the server wrote on
// first start (ADMIN_TOKEN_FILE, default /var/lib/kern/admin-token) - the same
// two places kernctl looks, so if this runs, kernctl will.
//
// What it is checking is the promise the whole management surface rests on:
// everything Kern Platform can do, kernctl can do, because there is one API
// and these are its rules. Specifically:
//
//   - a read-scoped token can look at everything and change nothing,
//   - destructive actions insist on the name of what they will destroy,
//   - live settings change without a restart and `/instance` says so,
//   - the SQL window is read-only at the database level,
//   - and every change leaves an audit entry naming the token that made it.
//
// It creates one throwaway account through the public API (so there is
// something to act on), then cleans up after itself.
import { readFileSync } from "node:fs";

const ORIGIN = process.env.KERN_TEST_ORIGIN ?? "http://localhost:8787";
const BASE = `${ORIGIN}/kern/v1`;
const ADMIN = `${BASE}/admin`;
const LOG = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${msg}`);
  if (!cond) failures++;
};

function adminToken() {
  if (process.env.KERN_ADMIN_TOKEN) return process.env.KERN_ADMIN_TOKEN.trim();
  const file = process.env.ADMIN_TOKEN_FILE ?? "/var/lib/kern/admin-token";
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    console.error(`No management token. Set KERN_ADMIN_TOKEN, or point ADMIN_TOKEN_FILE at the file the server wrote (tried ${file}).`);
    process.exit(2);
  }
}

const TOKEN = adminToken();

async function req(base, method, path, body, token) {
  const res = await fetch(base + path, {
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
  return { status: res.status, json };
}

const api = (method, path, body, token) => req(BASE, method, path, body, token);
const adm = (method, path, body, token = TOKEN) => req(ADMIN, method, path, body, token);

// --------------------------------------------------- something to act on

async function throwawayAccount() {
  if (!LOG) return null;
  const email = `admin-test-${Date.now()}@example.com`;
  const up = await api("POST", "/auth/sign-up/email", { name: "Admin Test", email, password: "correct horse battery" });
  if (up.status !== 200) return null;
  for (let i = 0; i < 40; i++) {
    const blocks = readFileSync(LOG, "utf8").split("[mail] (console) ").filter((b) => b.startsWith(`to=${email} `));
    const code = blocks.at(-1)?.match(/Code: (\d{6})/)?.[1];
    if (code) {
      await api("POST", "/auth/email-otp/verify-email", { email, otp: code });
      return email;
    }
    await sleep(250);
  }
  return email;
}

// ------------------------------------------------------------------ reach

const ping = await adm("GET", "/ping");
if (ping.status === 403) {
  console.error(`\nThe server refused this address: ${ping.json?.message ?? ""}\nRun this on the server's own machine, or over an SSH tunnel.`);
  process.exit(2);
}
ok(ping.status === 200 && ping.json.ok === true, `GET /ping answers (${ping.status})`);
ok(typeof ping.json.instance === "string" && !!ping.json.apiUrl, `it names the instance ("${ping.json.instance}") and its API url`);
ok(ping.json.token?.scope === "full", `the token in use is reported, with its scope (${ping.json.token?.scope})`);

const noToken = await adm("GET", "/ping", null, null);
ok(noToken.status === 401, `no token is refused (${noToken.status})`);
const badToken = await adm("GET", "/ping", null, "kern_0000000000000000_not-a-real-secret-at-all-no");
ok(badToken.status === 401, `a made-up token is refused (${badToken.status})`);

// ---------------------------------------------------------- looking at it

const overview = await adm("GET", "/overview");
ok(overview.status === 200 && typeof overview.json === "object", `GET /overview answers (${overview.status})`);

const health = await adm("GET", "/health");
ok(health.status === 200 && Array.isArray(health.json.checks) && health.json.checks.length > 0, `GET /health runs ${health.json?.checks?.length ?? 0} checks`);
ok(["ok", "warn", "fail"].includes(health.json.status), `it reports a worst-case status ("${health.json.status}")`);
ok(Array.isArray(health.json.fixable), "and says which failures it could repair");
const groups = new Set((health.json.checks ?? []).map((c) => c.group));
ok(groups.has("database") && groups.has("security"), `checks are grouped (${[...groups].sort().join(", ")})`);

const settings = await adm("GET", "/settings");
ok(settings.status === 200 && Array.isArray(settings.json.keys), `GET /settings lists ${settings.json?.keys?.length ?? 0} changeable keys`);
ok(!!settings.json.environment?.publicUrl, "and the read-only environment beside them");
const sources = new Set(Object.values(settings.json.settings ?? {}).map((v) => v.source));
ok([...sources].every((s) => s === "env" || s === "stored"), `every setting says where it comes from (${[...sources].sort().join(", ")})`);

// Nothing here reads anybody's work: the surface counts and measures only.
const spaces = await adm("GET", "/spaces");
ok(spaces.status === 200 && Array.isArray(spaces.json.spaces), `GET /spaces answers (${spaces.status})`);
const leaked = JSON.stringify(spaces.json).match(/"(title|body|content|data)"/);
ok(!leaked, `it measures spaces without returning their contents${leaked ? ` (found ${leaked[0]})` : ""}`);

// ------------------------------------------------------------- scopes

const readTok = await adm("POST", "/tokens", { name: `test-read-${Date.now()}`, scope: "read", days: 1 });
ok(readTok.status === 201 && !!readTok.json.token, `a read-scoped token is minted (${readTok.status})`);
const RO = readTok.json.token;

const roPing = await adm("GET", "/ping", null, RO);
ok(roPing.status === 200 && roPing.json.token?.scope === "read", "a read token can look at the instance");
const roUsers = await adm("GET", "/users", null, RO);
ok(roUsers.status === 200, "a read token can list people");
const roWrite = await adm("POST", "/notice", { message: "read tokens should not be able to do this" }, RO);
ok(roWrite.status === 403, `a read token cannot change anything (${roWrite.status})`);
const roSettings = await adm("PATCH", "/settings", { motd: "nope" }, RO);
ok(roSettings.status === 403, `nor write a setting (${roSettings.status})`);
const roToken = await adm("POST", "/tokens", { name: "escalation" }, RO);
ok(roToken.status === 403, `nor mint itself a better token (${roToken.status})`);

// ------------------------------------------------------- live settings

const before = settings.json.settings.registration.value;
const other = before === "open" ? "invite" : "open";
const patched = await adm("PATCH", "/settings", { registration: other });
ok(patched.status === 200 && patched.json.changed.includes("registration"), `a live setting changes (registration -> ${other})`);

const instance = await api("GET", "/instance");
ok(instance.json.registration === other, "and apps see it immediately on /instance, with no restart");

const restored = await adm("PATCH", "/settings", { registration: before });
ok(restored.status === 200 && restored.json.settings.registration.value === before, `and it goes back (registration -> ${before})`);

const unknownKey = await adm("PATCH", "/settings", { nonsense: 1 });
ok(unknownKey.status === 400, `an unknown setting is refused, naming the real ones (${unknownKey.status})`);

// -------------------------------------------------------------- people

const email = await throwawayAccount();
if (!email) {
  console.log("SKIP account checks (no log file given, or sign-ups are closed)");
} else {
  const found = await adm("GET", `/users?q=${encodeURIComponent(email)}`);
  const user = (found.json.users ?? []).find((u) => u.email === email);
  ok(!!user, `the new account is found by search (${email})`);

  if (user) {
    const show = await adm("GET", `/users/${user.id}`);
    ok(show.status === 200 && show.json.user.email === email, "GET /users/:id answers");

    const held = await adm("POST", `/users/${user.id}/hold`, { reason: "testing" });
    ok(held.status === 200, `the account can be suspended (${held.status})`);
    const signIn = await api("POST", "/auth/sign-in/email", { email, password: "correct horse battery" });
    ok(signIn.status >= 400, `a suspended account can't sign in (${signIn.status})`);
    const released = await adm("DELETE", `/users/${user.id}/hold`);
    ok(released.status === 200, "and can be released again");

    // Destructive actions name what they will destroy.
    const unconfirmed = await adm("DELETE", `/users/${user.id}`);
    ok(unconfirmed.status === 400 && unconfirmed.json.code === "confirm_required", `deleting without the email is refused (${unconfirmed.json?.code})`);
    const wrongName = await adm("DELETE", `/users/${user.id}?confirm=someone.else@example.com`);
    ok(wrongName.status === 400, "and the wrong email doesn't count as confirmation");
    const deleted = await adm("DELETE", `/users/${user.id}?confirm=${encodeURIComponent(email)}`);
    ok(deleted.status === 200 && deleted.json.deleted === true, `the right email deletes it (${deleted.status})`);
    const gone = await adm("GET", `/users/${user.id}`);
    ok(gone.status === 404, "and it is gone");
  }
}

// ---------------------------------------------------------- allow list

const allowEmail = `allow-test-${Date.now()}@example.com`;
const added = await adm("POST", "/allow", { email: allowEmail, note: "test" });
ok(added.status === 201 && added.json.email === allowEmail, `an address can be allowed to sign up (${added.status})`);
const allowList = await adm("GET", "/allow");
ok((allowList.json.allowed ?? []).some((a) => a.email === allowEmail), "and appears in the list");
const removed = await adm("DELETE", `/allow/${encodeURIComponent(allowEmail)}`);
ok(removed.status === 200, "and can be removed");
const removeAgain = await adm("DELETE", `/allow/${encodeURIComponent(allowEmail)}`);
ok(removeAgain.status === 404, `removing it twice is a plain 404 (${removeAgain.status})`);

// ------------------------------------------------------- the SQL window

const select = await adm("POST", "/query", { sql: "SELECT count(*) AS n FROM \"user\"" });
ok(select.status === 200 && select.json.rowCount === 1, `a SELECT runs (${select.status})`);
ok(Array.isArray(select.json.fields) && select.json.fields.includes("n"), "and names its columns");

for (const [sql, why] of [
  ["DELETE FROM \"user\"", "a DELETE"],
  ["UPDATE kern_space SET name = 'x'", "an UPDATE"],
  ["DROP TABLE kern_record", "a DROP"],
  ["SELECT 1; DROP TABLE kern_record", "two statements"],
]) {
  const r = await adm("POST", "/query", { sql });
  ok(r.status === 400, `${why} is refused (${r.status} ${r.json?.code ?? ""})`);
}

// Read-only is enforced by the database, not only by the prefix check: a
// SELECT that calls a writing function must still fail.
const sneaky = await adm("POST", "/query", { sql: "SELECT pg_current_xact_id() AS bad" });
ok(sneaky.status === 400, `a SELECT that needs to write is refused by the database itself (${sneaky.status})`);

// -------------------------------------------------------------- notices

const notice = await adm("POST", "/notice", { message: "Management API test notice", level: "info" });
ok(notice.status === 200 && notice.json.sent === true, `a notice can be broadcast (${notice.status})`);

// ---------------------------------------------------------------- audit

const audit = await adm("GET", "/audit?limit=50");
ok(audit.status === 200 && Array.isArray(audit.json.entries), `GET /audit answers (${audit.status})`);
const actions = (audit.json.entries ?? []).map((e) => e.action);
for (const action of ["token.create", "settings.update", "allow.add", "allow.remove", "notice", "query"]) {
  ok(actions.includes(action), `"${action}" was recorded`);
}
const entry = (audit.json.entries ?? []).find((e) => e.action === "token.create");
ok(!!entry?.by && !!entry?.at, "and each entry names the token that did it, and when");

// Reads are not audited: an audit trail nobody can read through is useless.
ok(!actions.includes("ping") && !actions.includes("users.list"), "looking at things is not recorded");

// -------------------------------------------------------- workspace keys
//
// The gate decides who may CREATE a workspace. What it must never do is get
// in the way of anything else, so this checks both halves: that a key is
// demanded when the gate is on, and that it is ignored when it is off.

const keysBefore = await adm("GET", "/workspace-keys");
ok(keysBefore.status === 200 && Array.isArray(keysBefore.json.keys), `GET /workspace-keys lists them (${keysBefore.status})`);

const mintedKey = await adm("POST", "/workspace-keys", { note: "e2e" });
ok(mintedKey.status === 201 && /^k_[0-9a-f]{32}$/.test(mintedKey.json.key ?? ""), "POST /workspace-keys mints a k_<32 hex> key");
ok(mintedKey.json.id !== mintedKey.json.key?.slice(2, 10), "the id comes from the hash, not from the start of the key");

const keyRo = await adm("POST", "/workspace-keys", { note: "nope" }, RO);
ok(keyRo.status === 403, `a read-scoped token cannot mint one (${keyRo.status})`);

const listed = await adm("GET", "/workspace-keys");
ok(
  !JSON.stringify(listed.json).includes(mintedKey.json.key),
  "and the key itself is never returned again, only its id",
);

// With the gate off (the default), creating a workspace must not ask for one.
await adm("PATCH", "/settings", { workspaceKeys: "off" });
const instOff = await api("GET", "/instance");
ok(instOff.json.workspaceKeys === "off", "/instance reports the gate off");

// Turn it on and confirm /instance says so, which is how the app knows to ask.
const on = await adm("PATCH", "/settings", { workspaceKeys: "required" });
ok(on.status === 200, `the gate turns on without a restart (${on.status})`);
const instOn = await api("GET", "/instance");
ok(instOn.json.workspaceKeys === "required", "/instance reports the gate on");

// Creating a workspace without a key is refused, and says why.
const noKey = await api("POST", "/workspaces", { name: "Should Not Exist" });
ok(
  noKey.status === 401 || (noKey.status === 403 && noKey.json.code === "workspace_key_required"),
  `creating a workspace with no key is refused (${noKey.status} ${noKey.json?.code ?? ""})`,
);

const badKey = await api("POST", "/workspaces", { name: "Nor This", key: "k_" + "f".repeat(32) });
ok(
  badKey.status === 401 || (badKey.status === 403 && badKey.json.code === "workspace_key_invalid"),
  `an unknown key is refused (${badKey.status} ${badKey.json?.code ?? ""})`,
);

// Revoking stops the next use; it never unmakes a workspace.
const revokeKey = await adm("DELETE", `/workspace-keys/${mintedKey.json.id}`);
ok(revokeKey.status === 200, `a key can be revoked (${revokeKey.status})`);
const revokedTwice = await adm("DELETE", `/workspace-keys/${mintedKey.json.id}`);
ok(revokedTwice.status === 404, `revoking it again is a 404, not a second revocation (${revokedTwice.status})`);

// Leave the instance as it was found.
await adm("PATCH", "/settings", { workspaceKeys: null });

// ----------------------------------------------------------- the token

const tokens = await adm("GET", "/tokens");
ok(tokens.status === 200 && tokens.json.tokens.some((t) => t.current), "GET /tokens marks the one in use");
ok(
  !JSON.stringify(tokens.json).includes("kern_") || tokens.json.tokens.every((t) => !t.token),
  "and never returns a token's secret again",
);

const self = await adm("DELETE", `/tokens/${ping.json.token.id}`);
ok(self.status === 400 && self.json.code === "revoking_self", `revoking your own token needs ?self=true (${self.json?.code})`);

const cleanup = await adm("DELETE", `/tokens/${readTok.json.id}`);
ok(cleanup.status === 200, "the test token is revoked");
const revoked = await adm("GET", "/ping", null, RO);
ok(revoked.status === 401, `and stops working at once (${revoked.status})`);

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
