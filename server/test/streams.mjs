// End-to-end check of streams against a running server whose emails go to its
// log. Start the server with GITHUB_API_URL=http://localhost:8799 so this
// script's mock GitHub receives the issues:
//   GITHUB_API_URL=http://localhost:8799 npm run dev > server.log 2>&1 &
//   node test/streams.mjs server.log
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const ORIGIN = process.env.KERN_TEST_ORIGIN ?? "http://localhost:8787";
const BASE = `${ORIGIN}/kern/v1`;
const LOG = process.argv[2];
const GH_PORT = Number(process.env.GH_MOCK_PORT ?? 8799);
const SITE = "https://site.example";
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

/** A submission to a stream endpoint. */
async function submit(url, body, { origin = SITE, headers = {}, raw, type = "application/json", method = "POST", redirect = "follow" } = {}) {
  const res = await fetch(url, {
    method,
    redirect,
    headers: { ...(origin ? { origin } : {}), ...(type ? { "content-type": type } : {}), ...headers },
    body: method === "POST" ? (raw ?? JSON.stringify(body)) : undefined,
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
    const m = blocks.at(-1)?.match(/Code: (\d{6})/);
    if (m) return m[1];
    await sleep(250);
  }
  throw new Error(`no OTP for ${email}`);
}

async function account(name) {
  const email = `${name.toLowerCase()}-${Date.now()}@example.com`;
  await call("POST", "/auth/sign-up/email", { name, email, password: "correct horse battery" });
  const code = await otpFor(email, "verification code");
  const v = await call("POST", "/auth/email-otp/verify-email", { email, otp: code });
  return { email, token: v.headers.get("set-auth-token") ?? v.json.token, name };
}

// ------------------------------------------------------------ mock GitHub

const issues = [];
const gh = createServer((req, res) => {
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", () => {
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${GH_TOKEN}`) return send(401, { message: "Bad credentials" });
    if (req.method === "GET" && req.url === "/repos/acme/site") return send(200, { full_name: "acme/site", private: true, has_issues: true, html_url: "https://github.com/acme/site" });
    if (req.method === "POST" && req.url === "/repos/acme/site/issues") {
      const body = JSON.parse(data);
      const number = issues.length + 1;
      issues.push(body);
      return send(201, { number, html_url: `https://github.com/acme/site/issues/${number}`, title: body.title, body: body.body, labels: (body.labels ?? []).map((name) => ({ name })), updated_at: "2026-10-13T12:00:00Z" });
    }
    send(404, { message: "Not Found" });
  });
});
const GH_TOKEN = `github_pat_${"x".repeat(40)}`;
await new Promise((r) => gh.listen(GH_PORT, r));

// ------------------------------------------------------------ setup

const A = await account("Owner");
const B = await account("Member");
const ws = await call("POST", "/workspaces", { name: "Stream Labs", invites: [{ email: B.email, role: "member" }] }, A.token);
const spaceId = ws.json.workspace.id;
await call("POST", `/invites/${ws.json.invites[0].invite.id}/accept`, null, B.token);

await call(
  "POST",
  `/spaces/${spaceId}/sync/push`,
  {
    changes: [
      { t: "projects", id: "p1", op: "upsert", full: true, data: { id: "p1", name: "Website", description: "", created_at: 1, updated_at: 1 } },
      { t: "boards", id: "b1", op: "upsert", full: true, data: { id: "b1", project_id: "p1", name: "Board", created_at: 1, updated_at: 1 } },
      { t: "board_columns", id: "c1", op: "upsert", full: true, data: { id: "c1", board_id: "b1", name: "Triage", status: "in_progress", created_at: 1, updated_at: 1 } },
      { t: "labels", id: "l1", op: "upsert", full: true, data: { id: "l1", name: "bug", created_at: 1 } },
      { t: "project_repos", id: "p1", op: "upsert", full: true, data: { project_id: "p1", owner: "acme", name: "site", connected_at: 1 } },
    ],
  },
  A.token,
);

const ticket = await call("POST", "/realtime/ticket", null, B.token);
const sock = new WebSocket(`${ORIGIN.replace(/^http/, "ws")}/kern/v1/realtime?ticket=${ticket.json.ticket}`);
const live = [];
sock.onmessage = (e) => live.push(JSON.parse(e.data));
await new Promise((r) => (sock.onopen = r));
sock.send(JSON.stringify({ type: "subscribe", space: spaceId }));
await sleep(200);

// ------------------------------------------------------------ management

const memberList = await call("GET", `/spaces/${spaceId}/streams`, null, B.token);
ok(memberList.status === 403, "members can't manage streams");

const created = await call("POST", `/spaces/${spaceId}/streams`, { name: "Bug reports", preset: "bug_report" }, A.token);
const stream = created.json.stream;
ok(created.status === 201 && /^[0-9a-f]{64}$/.test(stream.id) && /^kss_/.test(created.json.secret), "stream created with a 64-hex id and a secret");
ok(stream.url.endsWith(`/kern/${stream.id}`) && stream.config.fields.list.length === 7, "preset fields applied");
const url = `${ORIGIN}/kern/${stream.id}`;
const S = `/spaces/${spaceId}/streams/${stream.id}`;

const badCfg = await call("PATCH", S, { config: { security: { allowedOrigins: ["not an origin"] } } }, A.token);
ok(badCfg.status === 400 && badCfg.json.message.startsWith("security.allowedOrigins"), "invalid settings are refused with their path");

const patched = await call(
  "PATCH",
  S,
  { config: { task: { columnId: "c1", labelIds: ["l1", "gone"] }, security: { allowedOrigins: [SITE], rateLimit: { perMinute: 500, perHour: 5000 } }, responses: { redirectUrl: null } } },
  A.token,
);
ok(patched.status === 200 && patched.json.config.task.columnId === "c1" && patched.json.config.task.status === "inbox", "settings merge into the config");

// ------------------------------------------------------------ public submissions

const get = await submit(url, null, { method: "GET", type: null });
ok(get.status === 405, "GET is refused");
const unknown = await submit(`${ORIGIN}/kern/${"0".repeat(64)}`, { title: "x" });
ok(unknown.status === 404, "unknown stream is 404");
const noOrigin = await submit(url, { title: "x" }, { origin: null });
ok(noOrigin.status === 403 && noOrigin.json.code === "origin_required", "public stream needs an Origin");
const wrongOrigin = await submit(url, { title: "x" }, { origin: "https://evil.example" });
ok(wrongOrigin.status === 403 && wrongOrigin.json.code === "origin_not_allowed", "other websites are refused");

const pre = await fetch(url, { method: "OPTIONS", headers: { origin: SITE, "access-control-request-method": "POST" } });
ok(pre.status === 204 && pre.headers.get("access-control-allow-origin") === SITE, "preflight allows the configured origin");

const report = { title: "Checkout crashes", description: "Click [here](http://evil) @octocat", severity: "high", email: "Reporter@Example.com", page: "https://site.example/checkout" };
const first = await submit(url, report, { headers: { referer: "https://site.example/checkout" } });
ok(first.status === 201 && first.json.ok && first.json.status === "delivered" && !first.json.taskId, `submission delivered without exposing ids (${first.status})`);
ok(first.headers.get("access-control-allow-origin") === SITE && first.headers.get("kern-event") === String(first.json.id), "CORS and Kern-Event headers");
await sleep(250);
const change = live.find((m) => m.type === "changes" && m.changes.some((c) => c.t === "tasks"));
const task = change?.changes.find((c) => c.t === "tasks")?.data;
ok(!!task && change.by.startsWith("stream:"), "members receive the new task in realtime");
ok(task?.project_id === "p1" && task.column_id === "c1" && task.status === "in_progress" && task.priority === 3, "task lands in the column with the mapped priority");
ok(task?.description.includes("\\[here\\]") && task.description.includes("Received via the Bug reports stream"), "submitted Markdown is escaped and a footer added");
ok(change.changes.some((c) => c.t === "task_labels" && c.data.label_id === "l1") && !change.changes.some((c) => c.data?.label_id === "gone"), "existing labels applied, missing ones skipped");
ok(live.some((m) => m.type === "stream" && m.title === "Checkout crashes"), "members get a stream notification");

const dup = await submit(url, report);
ok(dup.status === 200 && dup.json.duplicate === true, "identical submission is recorded once");

const missing = await submit(url, { description: "no title" });
ok(missing.status === 422 && missing.json.code === "invalid_fields" && !!missing.json.fields.title, "missing required field is 422 with field errors");

const spam = await submit(url, { ...report, title: "Buy now", _hp: "http://spam" });
ok(spam.status === 201 && spam.json.ok, "honeypot spam looks accepted");

const form = await submit(url, null, { type: "application/x-www-form-urlencoded", raw: "title=From+a+form&description=Hello&severity=low", headers: { accept: "text/html" } });
ok(form.status === 201 && String(form.json).includes("Sent"), "HTML form posts get a thank-you page");
await call("PATCH", S, { config: { responses: { redirectUrl: "https://site.example/thanks" } } }, A.token);
const redirected = await submit(url, null, { type: "application/x-www-form-urlencoded", raw: "title=Again&description=Hi", headers: { accept: "text/html" }, redirect: "manual" });
ok(redirected.status === 303 && redirected.headers.get("location") === "https://site.example/thanks?kern=ok", "form posts redirect when configured");

const idem1 = await submit(url, { title: "Idem one", description: "a" }, { headers: { "idempotency-key": "order-42" } });
const idem2 = await submit(url, { title: "Idem two", description: "b" }, { headers: { "idempotency-key": "order-42" } });
ok(idem1.status === 201 && idem2.status === 200 && idem2.json.duplicate && idem2.json.id === idem1.json.id, "an idempotency key returns the first result");

await call("PATCH", S, { config: { security: { rateLimit: { perMinute: 1 } } } }, A.token);
const limited = await submit(url, { title: "Too fast", description: "x" });
ok(limited.status === 429 && Number(limited.headers.get("retry-after")) > 0, "per-sender rate limit answers 429 with Retry-After");
await call("PATCH", S, { config: { security: { rateLimit: { perMinute: 500 } } } }, A.token);

// ------------------------------------------------------------ authenticated streams

await call("PATCH", S, { config: { security: { auth: "token", allowedOrigins: [] }, responses: { returnIds: true } } }, A.token);
const noToken = await submit(url, { title: "t", description: "x" }, { origin: null });
ok(noToken.status === 401 && noToken.json.code === "missing_token", "token stream needs a bearer secret");
const badToken = await submit(url, { title: "t", description: "x" }, { origin: null, headers: { authorization: "Bearer kss_wrong" } });
ok(badToken.status === 401 && badToken.json.code === "bad_token", "wrong secret is refused");
const goodToken = await submit(url, { title: "Server says hi", description: "x" }, { origin: null, headers: { authorization: `Bearer ${created.json.secret}` } });
ok(goodToken.status === 201 && !!goodToken.json.taskId, "right secret delivers and returns the task id");

const rotated = await call("POST", `${S}/rotate`, { graceHours: 1 }, A.token);
ok(rotated.status === 200 && rotated.json.secret !== created.json.secret && !!rotated.json.stream.previousSecretExpiresAt, "rotation issues a new secret with a grace period");
const oldStill = await submit(url, { title: "Old secret", description: "x" }, { origin: null, headers: { authorization: `Bearer ${created.json.secret}` } });
ok(oldStill.status === 201, "the old secret works during the grace period");
await call("POST", `${S}/revoke-previous`, {}, A.token);
const oldGone = await submit(url, { title: "Old secret again", description: "x" }, { origin: null, headers: { authorization: `Bearer ${created.json.secret}` } });
ok(oldGone.status === 401, "the old secret stops working once revoked");
const revealed = await call("POST", `${S}/reveal`, {}, A.token);
ok(revealed.json.secret === rotated.json.secret, "admins can reveal the current secret");

await call("PATCH", S, { config: { security: { auth: "signature" } } }, A.token);
const secret = rotated.json.secret;
const signed = (body, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
const sBody = JSON.stringify({ title: "Signed", description: "from CI" });
const sHeader = signed(sBody);
const sig = await submit(url, null, { origin: null, raw: sBody, headers: { "kern-signature": sHeader } });
ok(sig.status === 201, "a signed request delivers");
const replay = await submit(url, null, { origin: null, raw: sBody, headers: { "kern-signature": sHeader } });
ok(replay.status === 401 && replay.json.code === "replayed_signature", "a replayed signature is refused");
const staleBody = JSON.stringify({ title: "Stale", description: "x" });
const stale = await submit(url, null, { origin: null, raw: staleBody, headers: { "kern-signature": signed(staleBody, Math.floor(Date.now() / 1000) - 3600) } });
ok(stale.status === 401 && stale.json.code === "stale_signature", "an old timestamp is refused");
const tampered = await submit(url, null, { origin: null, raw: staleBody.replace("Stale", "Evil"), headers: { "kern-signature": signed(staleBody) } });
ok(tampered.status === 401 && tampered.json.code === "bad_signature", "a changed body fails the signature");

// ------------------------------------------------------------ GitHub

const repoCfg = await call("PATCH", S, { config: { action: "task_issue", github: { repo: "acme/site", labels: ["from-stream"] } } }, A.token);
ok(repoCfg.status === 200, "GitHub repository set");
const badGh = await call("PUT", `${S}/github`, { token: `github_pat_${"y".repeat(40)}` }, A.token);
ok(badGh.status === 400 && /rejected the token/.test(badGh.json.message), "a token GitHub rejects isn't saved");
const goodGh = await call("PUT", `${S}/github`, { token: GH_TOKEN }, A.token);
ok(goodGh.status === 200 && goodGh.json.stream.github.tokenSet && goodGh.json.check.fullName === "acme/site" && !JSON.stringify(goodGh.json).includes(GH_TOKEN), "token checked and stored write-only");
const ghBody = JSON.stringify({ title: "Needs an issue", description: "ping @octocat about #12" });
const withIssue = await submit(url, null, { origin: null, raw: ghBody, headers: { "kern-signature": signed(ghBody) } });
ok(withIssue.status === 201 && withIssue.json.issue?.number === issues.length, `issue opened (${withIssue.status} ${JSON.stringify(withIssue.json)})`);
ok(issues.at(-1)?.body.includes("@​octocat") && issues.at(-1).body.includes("#​12") && issues.at(-1).labels[0] === "from-stream", "mentions neutralised, labels sent");
const pulled = await call("GET", `/spaces/${spaceId}/sync/pull?since=0`, null, B.token);
const link = pulled.json.changes.find((c) => c.t === "task_issue_links" && c.data.issue_number === withIssue.json.issue?.number);
const linkedTask = pulled.json.changes.find((c) => c.t === "tasks" && c.id === withIssue.json.taskId);
ok(link?.id === `acme/site|${withIssue.json.issue?.number}` && link.data.task_id === withIssue.json.taskId, "issue linked to the task the way the app expects");
ok(linkedTask?.data.description === link?.data.synced_body, "linked task starts in step with the issue");

// ------------------------------------------------------------ inbox, previews, tests, log

await call("PATCH", S, { config: { action: "inbox", security: { auth: "public", allowedOrigins: [SITE] } } }, A.token);
const toInbox = await submit(url, { title: "An idea", description: "Dark mode" });
ok(toInbox.status === 201, "inbox delivery");
await sleep(200);
ok(live.some((m) => m.type === "changes" && m.changes.some((c) => c.t === "inbox_items" && c.data.content.startsWith("An idea"))), "inbox item synced");

const preview = await call("POST", `${S}/preview`, { payload: { title: "Preview", description: "**x**" }, config: { templates: { title: "[{{severity | default:\"none\"}}] {{title}}" } } }, A.token);
ok(preview.status === 200 && preview.json.valid && preview.json.title === "[none] Preview" && preview.json.body.includes("\\*\\*x\\*\\*"), "preview renders unsaved templates");
const invalidPreview = await call("POST", `${S}/preview`, { payload: { severity: "nope" } }, A.token);
ok(invalidPreview.json.valid === false && !!invalidPreview.json.errors.title && !!invalidPreview.json.errors.severity, "preview reports field errors");
const test = await call("POST", `${S}/test`, { payload: { title: "Test send", description: "x" } }, A.token);
ok(test.status === 200 && test.json.status === "delivered" && !!test.json.inboxId, "test send delivers");

const events = await call("GET", `${S}/events?limit=100`, null, A.token);
const statuses = new Set(events.json.events.map((e) => e.status));
ok(["delivered", "duplicate", "rejected", "spam"].every((s) => statuses.has(s)), `log records every outcome (${[...statuses].join(", ")})`);
ok(events.json.events.every((e) => !("payload" in e)) && events.json.events.some((e) => e.test), "the list omits payloads and marks tests");
const spamEvent = events.json.events.find((e) => e.status === "spam");
const detail = await call("GET", `${S}/events/${events.json.events.find((e) => e.status === "delivered").id}`, null, A.token);
ok(detail.status === 200 && typeof detail.json.payload === "object", "a delivery's detail includes its data");
const filtered = await call("GET", `${S}/events?status=rejected`, null, A.token);
ok(filtered.json.events.length > 0 && filtered.json.events.every((e) => e.status === "rejected"), "the log filters by status");

const blocked = await call("POST", `${S}/events/${spamEvent.id}/block`, {}, A.token);
ok(blocked.status === 200 && blocked.json.config.security.blockedSenders.includes(spamEvent.sender), "a sender can be blocked");
const fromBlocked = await submit(url, { title: "Blocked", description: "x" });
ok(fromBlocked.status === 201, "blocked senders are answered like success");
const latest = await call("GET", `${S}/events?limit=1`, null, A.token);
ok(latest.json.events[0].status === "spam" && latest.json.events[0].code === "blocked_sender", "and logged as spam");
await call("PATCH", S, { config: { security: { blockedSenders: [] } } }, A.token);

const redeliver = await call("POST", `${S}/events/${detail.json.id}/redeliver`, {}, A.token);
ok(redeliver.status === 200 && redeliver.json.status === "delivered", "a logged delivery can be redelivered");

const paused = await call("PATCH", S, { enabled: false }, A.token);
const whilePaused = await submit(url, { title: "Paused", description: "x" });
ok(paused.json.enabled === false && whilePaused.status === 403 && whilePaused.json.code === "stream_paused", "paused streams refuse submissions");

const activity = await call("GET", `/workspaces/${spaceId}/activity`, null, A.token);
ok(["stream.created", "stream.rotated", "stream.revealed", "stream.paused", "stream.github_token"].every((a) => activity.json.some((x) => x.action === a)), "stream changes are in the activity log");

const removed = await call("DELETE", S, null, A.token);
const afterDelete = await submit(url, { title: "Gone", description: "x" });
ok(removed.status === 200 && afterDelete.status === 404, "deleted streams stop answering");

sock.close();
gh.close();
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
