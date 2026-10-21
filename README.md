# Kern, self-hosted

Run the server behind [Kern](https://github.com/kern-platform/kern) yourself.

Kern is a desktop app that works entirely on your own computer. **Kern Cloud** is
the optional part: an account, a personal space synced between your devices, and
shared workspaces people collaborate in. This repository is that server — the
same code that runs the public one — so you can put it on your own machine, in
your own company, behind your own TLS, with nobody else holding the data.

Nothing here is a cut-down edition. Accounts, sync, realtime collaboration,
invitations, workspaces, whiteboard images, public share links, calendar feeds
and stream endpoints are all the same server.

```
┌───────────────────────┐        ┌────────────────────────┐
│  Kern (desktop app)   │───────▶│  Your Kern server      │
│  accounts, sync, live │  TLS   │  Node + PostgreSQL     │
└───────────────────────┘        │                        │
                                 │  /kern/v1/*    the app │
┌───────────────────────┐        │  /kern/v1/admin/* mgmt │
│  Kern Platform        │───────▶│                        │
│  manage it, with a UI │  local └────────────────────────┘
└───────────────────────┘    or SSH      ▲
                                         │ loopback, or SSH
┌───────────────────────┐                │
│  kernctl              │────────────────┘
│  manage it, headless  │
└───────────────────────┘
```

Three pieces, each in this repository:

| | What it is | Where it runs |
|---|---|---|
| [`server/`](server/) | The server itself: Node 20+, PostgreSQL 15+, one process | Linux, macOS, Windows, Docker |
| [`platform/`](platform/) | **Kern Platform** — a desktop app for managing it | Windows, macOS, Linux |
| [`cli/`](cli/) | `kernctl` and the installer — the same management API, headless | Linux, POSIX `sh` |

## Install it

On a Linux box, one command. It picks Docker if Docker is there, systemd and
your own PostgreSQL if not, generates the secrets, writes `.env`, starts the
server and installs `kernctl`:

```sh
sudo ./cli/install.sh --url https://api.relf.cc --name "Relf"
```

It finishes by printing a single line beginning `kern-platform:` — paste that
into Kern Platform and the app is connected. Running it again upgrades rather
than resets: an existing `.env` keeps its secrets.

With Docker and nothing else:

```sh
cp .env.example .env     # addresses are set; generate the three secrets
docker compose up -d --build
docker compose logs api  # the first management token, printed once
```

The API is published on `127.0.0.1:8787` only. That is deliberate, and it stays
that way: this instance is reached through a **Cloudflare Tunnel**, so
`cloudflared` dials out from the server and no inbound port is ever opened, no
certificate lives on the box and no origin IP appears in DNS. A reverse proxy
with its own certificate is the alternative. Either way, see
[docs/SELF-HOSTING.md](docs/SELF-HOSTING.md#putting-it-on-the-internet) before
anybody else syncs to it.

### The addresses

Two hostnames, both to the same machine and the same process:

| | | |
|---|---|---|
| `api.relf.cc` | `PUBLIC_URL` | What the Kern app talks to: the API, the realtime socket, sign-in, invite and share links. |
| `streams.relf.cc` | `STREAMS_URL` | Stream endpoints and their phone capture pages, so an address pasted into a form or a webhook never carries the API host. |

The tunnel's ingress rules narrow the second name to stream paths only, and
refuse the management API on both — which matters more than it looks, because
`cloudflared` connects from `127.0.0.1` and the server allows loopback
unconditionally.
[docs/SELF-HOSTING.md](docs/SELF-HOSTING.md#putting-it-on-the-internet) has the
ingress rules, the DNS, and Caddy and nginx for the proxy route.

## Point Kern at it

In Kern: **Settings → Account & Cloud → Kern server → Add…** Type
`https://api.relf.cc`, and Kern asks it what it is before saving anything. Your
account on your server is separate from every other Kern server, so it asks you
to sign in there.

Over plain HTTP, Kern will only sign in to this machine (`127.0.0.1`,
`localhost`) or a private network — never a public address, because the session
and everything you sync would cross the internet in the clear.

## Manage it

**Kern Platform** is the desktop app: health, people, spaces, streams, settings,
logs, the audit trail and a read-only SQL console. It talks to the management
API over loopback or an SSH tunnel, the same as `kernctl`.

**`kernctl`** is the same thing in a terminal, for a server with no graphical
session. On the server's own machine it needs no setup at all — it reads the
management token from where the server wrote it.

```sh
kernctl status                 # what this instance is, and how much is in it
kernctl health --fix           # run every check, repair what can be repaired
kernctl heal                   # repair everything, then check again
kernctl users list --unverified
kernctl pair                   # mint a token and print one line for Kern Platform
kernctl backup /srv/backups/kern.sql.gz
```

`kernctl help` lists the rest. Every command takes `--json`, which needs
nothing but `curl` and is what you want in a monitoring check. Exit codes are
meaningful: `0` fine, `1` refused, `2` called wrongly, `3` unreachable, `4`
health failing.

## How it fits together

- **[docs/SELF-HOSTING.md](docs/SELF-HOSTING.md)** — installing, TLS and reverse
  proxies, mail, registration, backups, upgrades, troubleshooting.
- **[docs/PROTOCOL.md](docs/PROTOCOL.md)** — how the Kern app talks to a server,
  and how Kern Platform and `kernctl` manage a headless one. Read this before
  changing either side.
- **[docs/streams.md](docs/streams.md)** — stream endpoints: turning a form,
  a webhook or an email into a task.

## Configuration

Everything is environment variables; [`.env.example`](.env.example) documents
each one next to a working default. `PUBLIC_URL` and `STREAMS_URL` are already
set to this instance's hostnames, so only three secrets have to be generated:
`POSTGRES_PASSWORD`, `BETTER_AUTH_SECRET` and `STREAMS_ENCRYPTION_KEY`. The
installer generates all three for you.

A few that decide the shape of your instance:

| | |
|---|---|
| `REGISTRATION` | `open`, `invite` (the default) or `closed`. The first account is always allowed, so a fresh server is usable. |
| `ADMIN_LOCAL_ONLY` | `true` by default: the management API answers only the server's own machine. |
| `SMTP_*` | Without them, verification codes go to the server log instead of an inbox. Fine for one person; nobody else can finish signing up. |
| `INSTANCE_NAME` | What the server calls itself in emails, on invite pages and in the app's sign-in screen. |

## Developing

```sh
cd server && npm install && npm run dev        # the server, on :8787
cd platform && npm install && npm run app:dev  # Kern Platform
```

Point a development build of Kern at it with `KERN_CLOUD_URL=http://localhost:8787/kern/v1`,
which overrides the choice in Settings and locks it.

```sh
cd server   && npm run typecheck && npm test && npm run test:e2e
cd platform && npm run typecheck && npm test && cargo test --manifest-path src-tauri/Cargo.toml
sh -n cli/kernctl && sh -n cli/install.sh
```

## Licence

Apache-2.0. See [LICENSE](LICENSE). Run it, change it, run a changed copy as a
service, build something commercial on it — keep the notice and the attribution,
and state what you changed. The licence also grants the patent rights needed to
use it.

The Kern desktop app is a separate project under its own licence.
