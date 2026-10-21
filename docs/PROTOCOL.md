# How things talk to a Kern server

Three different clients reach a Kern server, and they use two different
surfaces:

| Client | Surface | Who it is |
|---|---|---|
| **Kern**, the desktop app | `/kern/v1/*` | A person with an account, syncing their own spaces |
| **Kern Platform**, the management app | `/kern/v1/admin/*` | An administrator of the server |
| **`kernctl`**, the CLI | `/kern/v1/admin/*` | The same administrator, headless |

The two surfaces are deliberately separate. The app surface can read and write
one person's work and nothing about the instance; the management surface can
read everything *about* the instance and none of anybody's work. Neither is a
superset of the other, and a leaked token on one side doesn't become the other.

- [Part 1: the app](#part-1-the-app)
  - [The handshake](#the-handshake)
  - [Choosing a server](#choosing-a-server)
  - [Signing in](#signing-in)
  - [Sync](#sync)
  - [Realtime](#realtime)
- [Part 2: managing a server](#part-2-managing-a-server)
  - [Reaching the management API](#reaching-the-management-api)
  - [Management tokens](#management-tokens)
  - [Pairing Kern Platform](#pairing-kern-platform)
  - [What a headless server offers](#what-a-headless-server-offers)
- [Adding to either side](#adding-to-either-side)

---

# Part 1: the app

The app-side code lives in the Kern repository under
`src-tauri/src/domain/cloud/`:

| | |
|---|---|
| `servers.rs` | Which server this copy of Kern talks to, and the rules about where a token may be sent |
| `client.rs` | The HTTP client: given a base, sends to it |
| `mod.rs` | The account, spaces, status, and the Tauri commands the interface calls |
| `sync.rs` | The change log, pushes and pulls |

Two things to know before reading any of it:

**Requests are made in Rust, not in the webview.** The session token lives in
the OS credential store and never reaches the front end. The window's CSP
can't refuse a request the backend makes, which is exactly why the address is
not something the front end can write — see [Choosing a
server](#choosing-a-server).

**The front end only ever opens the realtime socket**, and it does that with a
short-lived ticket rather than the session token.

## The handshake

The first request the app makes about an address it has been given. Public,
unauthenticated, before any account exists:

```
GET /kern/v1/instance
```

```json
{
  "service": "kern-cloud",
  "protocol": 1,
  "name": "Acme Labs",
  "apiUrl": "https://kern.example.com/kern/v1",
  "registration": "invite",
  "notice": "Maintenance Sunday 02:00 UTC",
  "contact": "admin@example.com",
  "features": {
    "workspaces": true,
    "assets": true,
    "streams": true,
    "shares": true,
    "inboundEmail": false,
    "email": true
  }
}
```

It answers three questions, and nothing else:

- **Is this a Kern server?** `service: "kern-cloud"`. Anything else and the app
  says so plainly: something replied, but it isn't Kern — usually a proxy's
  error page or the wrong port.
- **What will it let me do?** `registration` decides whether the sign-in screen
  offers to create an account, or explains that this server is invitation-only
  or closed. `features.email` being false is why the screen says codes come
  from the administrator rather than an inbox.
- **What should I call it?** `name`, on the sign-in screen and in the server
  list.

`protocol` is the contract. The app refuses a server whose protocol is higher
than the one it implements, naming both numbers, rather than failing later in a
way nobody can diagnose. Raise it only for a change that would break an older
app — adding an endpoint doesn't count. The server's number is
`PROTOCOL` in [`server/src/routes/instance.ts`](../server/src/routes/instance.ts);
the app's is `PROTOCOL` in `domain/cloud/mod.rs`. **Both must change together.**

This endpoint is a free description of the host to anyone who asks, so it holds
no counts, no component versions and nothing about who has an account here.

## Choosing a server

The list of servers lives in `servers.json` in the app's data directory, which
only the backend writes. It is not a setting, and the reason is worth stating
plainly:

> The session token is sent as a bearer to whatever address the backend
> resolves, and that request is made in Rust where the window's CSP does not
> apply. `settings_set` takes any key from the front end. An address stored
> there would therefore be a way for anything running in the webview to hand
> the session token to a host of its choosing.

Three things guard it, in order of how much they actually matter:

1. **A token belongs to one origin.** The credential-store entry is keyed by
   host (`kern-cloud-session@kern.example.com`), so pointing Kern at another
   server does not carry the existing session there — the new server simply has
   no token and asks for a sign-in. *This is the part that defuses the attack:
   even a silent switch yields nothing.*
2. **`KERN_CLOUD_URL` wins and locks the choice.** Whoever starts Kern — a
   managed deployment, a development run — keeps the final say, and the
   interface cannot override it. Settings shows the choice as locked and says
   why.
3. **Adding a server asks the person, in a native dialog naming the host.** The
   webview can propose a server; it cannot accept one.

Where a token may be sent at all:

| Address | Allowed | Why |
|---|---|---|
| `https://` anything | yes | Encrypted, and the host's name is checked |
| `http://127.0.0.1`, `::1`, `localhost` | yes | The same machine, or an SSH tunnel to it |
| `http://192.168.x`, `10.x`, `.local`, `.internal` | yes, with a warning | A home or office network |
| `http://` a public address | **no** | The session would cross the internet in the clear |

Addresses are normalised on the way in: a bare host gets `https://`, and
`/kern/v1` is appended unless it is already there. `kern.example.com` and
`https://kern.example.com/kern/v1/` are the same server.

The commands the interface calls, all in `domain/cloud/mod.rs`:

```
cloud_servers        the list
cloud_server_check   ask an address what it is (sends no token, saves nothing)
cloud_server_add     vet, confirm in a native dialog, add, select
cloud_server_select  switch; None means the public server
cloud_server_remove  forget it, and the session held for it
```

Any of the last three emits `kern://cloud-server`. A different server means a
different account and a different set of spaces, so the interface starts again
rather than showing one server's data under another's name.

## Signing in

[Better Auth](https://better-auth.com) at `/kern/v1/auth/*`, with the bearer
plugin: **no cookies, no redirects, no web pages.** Email and password, with
emailed one-time codes for verification, code sign-in and recovery.

A successful sign-in or verification carries the session in a `set-auth-token`
response header. The backend reads it there, puts it in the OS credential
store under the entry for that server, and sends it as
`Authorization: Bearer <token>` from then on.

```
POST /kern/v1/auth/sign-up/email
POST /kern/v1/auth/sign-in/email
POST /kern/v1/auth/email-otp/send-verification-otp
POST /kern/v1/auth/sign-in/email-otp
GET  /kern/v1/auth/list-sessions
```

A `401` anywhere else means the session has ended — suspended, revoked,
deleted, or expired. The app deletes the stored token, sets its status to
`signed_out`, and says so once rather than retrying.

Email verification is required (`requireEmailVerification`), which is why a
server with no SMTP needs `kernctl users verify <email>` to get the first
person in.

## Sync

Each space — the personal space, or a workspace — has a local replica with the
same schema as the ordinary local database, so every feature works the same and
keeps working with no connection.

Only core records sync: projects, boards, tasks, issues, milestones, notes,
whiteboards and the rest of `SYNCED_TABLES` in
[`server/src/routes/sync.ts`](../server/src/routes/sync.ts). Files, folders,
repositories, terminals and environment settings always stay on the computer.
This is not a setting; the server refuses anything else.

**Pushing.** Field-level patches — only the columns that changed, or the full
row for a new record:

```
POST /kern/v1/spaces/:space/sync/push
```

```json
{
  "conn": "<realtime connection id, so the echo is recognised>",
  "changes": [
    { "op": "upsert", "t": "tasks", "id": "…", "data": { "title": "New title" } },
    { "op": "upsert", "t": "tasks", "id": "…", "data": { … }, "full": true },
    { "op": "delete", "t": "notes", "id": "…" }
  ]
}
```

The server merges each patch into the stored row — last writer wins per field,
so two people editing different fields of the same task both keep their edit —
assigns each change the space's next sequence number, and replies with the
merged rows. A client learns what others changed from its own push reply.

**Pulling.**

```
GET /kern/v1/spaces/:space/sync/pull?since=<cursor>&limit=<n>
```

```json
{ "changes": [ { "seq": 41, "t": "tasks", "id": "…", "op": "upsert", "data": { … } } ],
  "cursor": 41, "head": 41, "hasMore": false, "role": "member" }
```

Sequence numbers are allocated under a row lock on the space, so they are
contiguous within a push and commit in order. That is what makes the fast path
safe: a client that has applied everything up to *N* can apply a broadcast
starting at *N+1* directly, and otherwise pulls. `since=0` skips deleted rows
— a first sync has no tombstones to care about.

One background worker pushes (woken by the replica's commit hook) and pulls.
`sync.rs` holds the change log and the merge; a rejected patch doesn't consume
a sequence number, so the block stays contiguous.

## Realtime

The socket is opened by the *interface*, not the backend, so it must not need
the session token. It uses a ticket instead:

```
POST /kern/v1/realtime/ticket     ->  { "ticket": "…", "expiresIn": 60 }
```

Short-lived and single-use. Then the WebSocket, at the API base with the
scheme swapped (`https` → `wss`):

```
wss://kern.example.com/kern/v1/realtime?ticket=…
```

The client subscribes to the spaces it has open. The server pushes:

| Message | What it is |
|---|---|
| `changes` | Records committed by somebody's push — durable, and applied via `cloud_apply` |
| `presence` | Who is where, cursors and selections — ephemeral, never stored |
| `ephemeral` | Relayed live interaction, such as a whiteboard drag |
| `space` | Workspace events: updated, members changed, you were removed, deleted |
| `invite` | A new invitation for the signed-in user |
| `stream` | A stream delivered a submission into the space |
| `notice` | A message from the administrator (`kernctl notice "…"`) |
| `signed_out` | This session has ended: suspended, revoked or deleted |

Ephemeral traffic is rate-limited per connection with a token bucket. State is
per process, which suits one server; running several instances would need
shared pub/sub.

**If a reverse proxy doesn't pass `Upgrade` and `Connection`, sync works and
live collaboration silently doesn't.** It is the most common self-hosting
mistake — see [SELF-HOSTING.md](SELF-HOSTING.md#nginx).

---

# Part 2: managing a server

A headless server is not a lesser citizen. Kern Platform and `kernctl` speak
**only** `/kern/v1/admin/*`, and the same surface for both is what guarantees
it: anything the desktop app can do, the CLI can do.

Three rules hold throughout the management API:

- **Nothing here reads anybody's work.** It counts records, measures spaces and
  lists who belongs to what. It never returns the contents of a task, note or
  whiteboard. An administrator keeps a server running without reading what
  people put in it — and a leaked management token must not be a way to read
  the data either.
- **Destructive actions name what they will destroy.** Deleting an account or
  purging a workspace takes the name or email as confirmation
  (`?confirm=alice@example.com`, or `confirm` in a JSON body), so a mistyped id
  can't take out the wrong one.
- **Everything that changes something is recorded** in `kern_admin_audit`, with
  the token that did it.

## Reaching the management API

Two gates, in this order, in
[`server/src/admin/guard.ts`](../server/src/admin/guard.ts):

**1. Where the request came from.** By default loopback only. That is what
makes "manage it from the same machine, or over an SSH tunnel" the normal way
in: nothing on the network can even attempt a token. Opening it up takes
`ADMIN_LOCAL_ONLY=false` *and* an explicit `ADMIN_ALLOW_FROM` list, because a
management API on a public port is a different risk from a sync API.

The client address comes from the socket, **not from a header**. A proxy header
is attacker-controlled and trusting one here would undo the gate entirely. So
behind a reverse proxy it is the proxy that is on the allow list, and you
restrict who reaches it there instead.

**2. A management token**, as `Authorization: Bearer kern_…`.

A refusal says which gate stopped you. `admin_local_only` means the address
list, not the token — an administrator who has just opened a port needs to know
the difference.

## Management tokens

```
kern_<16 hex id>_<secret>
```

Only the SHA-256 of the secret half is stored, so a stolen database yields no
working tokens; the id half lets a lookup find one row instead of comparing
against every token. The whole token is shown exactly once, when it is created.

Scopes are `full` and `read`. A `read` token can look at everything and change
nothing, which is what a monitoring check should hold.

**On first start, when no tokens exist, one is minted automatically** and
written where the installer said (`ADMIN_TOKEN_FILE`, default
`/var/lib/kern/admin-token`). That is the whole mechanism behind "`kernctl` on
the server's own machine needs no setup": it reads the file. Keep it readable
only by the service account.

## Pairing Kern Platform

The desktop management app needs an address and a token. Typing a token by hand
is error-prone, so `kernctl` mints one and encodes both into a single line:

```sh
$ kernctl pair "Kern Platform"

  Acme Labs is ready to manage.

  Server    http://127.0.0.1:8787/kern/v1
  Token     kern_a1b2c3d4e5f60718_…

  Or paste this single line into Kern Platform:

  kern-platform:eyJ1cmwiOiJodHRwOi8vMTI3LjAuMC4xOjg3ODcv…
```

The line is `kern-platform:` followed by base64url (unpadded) of
`{"url":…,"token":…,"name":…}`. Kern Platform decodes it in Rust
(`decode_pairing` in `platform/src-tauri/src/servers.rs`), vets the address by
the same rules the app uses, and stores the token in the OS credential store.

Over a tunnel, forward the port first — the address in the line is the one the
server knows itself by:

```sh
ssh -L 8787:127.0.0.1:8787 you@server
```

`kernctl pair --json` gives the same three values as JSON, for a script.

## What a headless server offers

Every one of these is a management API call, so Kern Platform shows the same
thing in a window:

```sh
kernctl status                     # what this instance is, and how much is in it
kernctl health [--fix] [--fix=ID]  # checks by group, and the repairs that are safe
kernctl heal                       # repair everything, then check again
kernctl doctor                     # this machine, and the path to the server
kernctl logs [-f] [--level warn]   # the server's in-memory ring buffer
kernctl audit [N]                  # what management tokens have done
kernctl query "SELECT …"           # a read-only look at the database

kernctl users list|show|hold|release|verify|revoke-sessions|delete
kernctl allow list|add|remove      # who may sign up when REGISTRATION=invite
kernctl spaces list|show|delete
kernctl invites list|revoke
kernctl streams list|enable|disable

kernctl settings                   # every setting, and where it comes from
kernctl set <key> <value>          # change one live; "default" falls back to .env
kernctl notice "TEXT" [--warn]     # tell everyone currently connected something

kernctl token list|new|revoke
kernctl service status|start|stop|restart|logs|upgrade
kernctl backup [FILE] | restore <FILE>
kernctl use <url> [--token T]
```

`kernctl` is POSIX `sh` and `curl`, nothing else required. Formatted tables use
`python3` when it is there; **`--json` always works and needs neither**, which
is what you want in a script or a monitoring check. Exit codes are meaningful:

| | |
|---|---|
| `0` | Fine |
| `1` | Refused by the server |
| `2` | Called wrongly |
| `3` | Couldn't reach the server |
| `4` | `health` found a failure |

Settings changed with `kernctl set` are **live**: `registration`, the notice,
whether publishing is on. Apps see the difference on their next sign-in screen
with no restart, because `/instance` and the sign-up checks read the live value
rather than the environment. `kernctl settings` shows where each value is
coming from — a live override, `.env`, or the built-in default.

---

# Adding to either side

**A new app endpoint.** Add the route under `config.basePath` in
`server/src/routes/`, and the call in Kern's `domain/cloud/`. No protocol bump:
an app that doesn't know the endpoint doesn't call it. If the app can't work
without it, that is a protocol bump — both numbers, together.

**A new synced table.** Add it to `SYNCED_TABLES` in `server/src/routes/sync.ts`
*and* to the replica schema on the app side. The server refuses tables it
doesn't know, so a one-sided change fails closed, which is the right way round.
Also add it to `TABLE_DOMAINS` in `src/features/cloud/actions.ts` so the
interface refreshes when a collaborator changes one.

**A new management capability.** Add the route to
`server/src/routes/admin.ts` — it is behind `requireAdmin` by virtue of being
mounted there — then the command in `platform/src-tauri/src/admin.rs` and the
subcommand in `cli/kernctl`. Adding it to only one client breaks the promise
that a headless server can do everything a windowed one can. If it changes
something, give it an audit entry; if it destroys something, make it name what.

**A new live setting.** Add it to `FIELDS` in `server/src/live.ts` (which is
what `LIVE_KEYS` is derived from) so `kernctl set` and Kern Platform can change
it without a restart, and read `live.<key>` rather than `config.<key>`
wherever it is used.
