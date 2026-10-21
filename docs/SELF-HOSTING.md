# Self-hosting Kern

Everything you need to run the server, keep it running, and let other people
sync to it safely.

- [What you need](#what-you-need)
- [Installing](#installing)
- [Putting TLS in front of it](#putting-tls-in-front-of-it)
- [Who may sign up](#who-may-sign-up)
- [Mail](#mail)
- [Managing it](#managing-it)
- [Keeping it healthy](#keeping-it-healthy)
- [Backups](#backups)
- [Upgrading](#upgrading)
- [Troubleshooting](#troubleshooting)
- [Uninstalling](#uninstalling)

## What you need

- **Linux**, for the installer. The server itself is plain Node and runs on
  macOS and Windows too; only `cli/install.sh` is Linux-specific.
- **PostgreSQL 15 or newer**, or Docker (which brings its own).
- **Node 20 or newer**, for a native install. Docker doesn't need it.
- **A hostname and a TLS certificate**, if anybody but you will use it.

One person syncing their own devices is a very small load: a server with 1 GB
of memory is plenty. What grows is the database, and what grows fastest in it
is whiteboard images — see `ASSET_QUOTA_MB` in [`.env.example`](../.env.example).

## Installing

### The installer

```sh
sudo ./cli/install.sh --url https://kern.example.com --name "Acme Labs"
```

It checks the machine, picks a shape, generates the secrets, writes `.env`,
starts the server, installs `kernctl`, waits for the server to answer, and
prints the one line that connects Kern Platform to it.

| | |
|---|---|
| `--dir PATH` | Where to install. Default `/opt/kern`. |
| `--url URL` | The address people will use. Default `http://<this machine's ip>:8787`. |
| `--name TEXT` | What the instance calls itself. Default the hostname. |
| `--registration MODE` | `open`, `invite` (default) or `closed`. |
| `--port N` | The port the API listens on. Default `8787`. |
| `--mode docker\|native` | How to run it. Default: Docker if it is installed. |
| `--source PATH\|URL` | Where to get the code from. Default: this checkout. |
| `--user NAME` | The service account, native mode. Default `kern`. |
| `--yes` | Don't ask anything. |

It is safe to run twice. An existing `.env` keeps its secrets, so a second run
upgrades rather than resets. Nothing is written outside the install directory,
`/etc/kernctl`, `/usr/local/bin/kernctl` and (native only) the systemd unit.

**docker mode** runs PostgreSQL and the API as containers under
`docker compose`. Nothing else is needed and upgrades are one command.

**native mode** builds the server with Node, runs it under systemd as
`kern-server`, and expects you to bring your own PostgreSQL. The unit is
hardened (`NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`), and the
only path it can write is `/var/lib/kern`, where the management token lives.

### By hand, with Docker

```sh
cp .env.example .env
```

Set the four values it asks for:

```sh
POSTGRES_PASSWORD=$(openssl rand -base64 36)
BETTER_AUTH_SECRET=$(openssl rand -base64 48)
STREAMS_ENCRYPTION_KEY=$(openssl rand -base64 32)
PUBLIC_URL=https://kern.example.com
```

Then:

```sh
docker compose up -d --build
docker compose logs api        # the first management token, printed once
```

**Back up `STREAMS_ENCRYPTION_KEY`.** It encrypts stream secrets, GitHub tokens
and Turnstile keys. If it is unset, a key is derived from `BETTER_AUTH_SECRET`,
which means rotating that secret makes stored stream credentials unreadable.

### By hand, without Docker

```sh
cd server
npm ci
npm run build
DATABASE_URL=postgres://… node dist/index.js
```

Migrations run at startup, so there is no separate step. Put it behind a
process manager that restarts it, and behind a reverse proxy with TLS.

## Putting TLS in front of it

`docker-compose.yml` publishes the API on `127.0.0.1:8787` and nothing else.
That is the whole shape of the deployment: **do not change it to `0.0.0.0`.**
Put a reverse proxy with TLS in front instead.

The server needs one thing from the proxy beyond ordinary forwarding: the
realtime socket is a WebSocket upgrade, so it must pass `Upgrade` and
`Connection` through.

### Caddy

```
kern.example.com {
	reverse_proxy 127.0.0.1:8787
}
```

Caddy gets the certificate itself and handles WebSockets without being asked.

### nginx

```nginx
server {
	listen 443 ssl http2;
	server_name kern.example.com;

	ssl_certificate     /etc/letsencrypt/live/kern.example.com/fullchain.pem;
	ssl_certificate_key /etc/letsencrypt/live/kern.example.com/privkey.pem;

	# Whiteboard images and stream submissions; see ASSET_MAX_BYTES.
	client_max_body_size 8m;

	location / {
		proxy_pass http://127.0.0.1:8787;
		proxy_http_version 1.1;

		# The realtime socket. Without these two lines sync works and live
		# collaboration silently doesn't.
		proxy_set_header Upgrade    $http_upgrade;
		proxy_set_header Connection "upgrade";

		proxy_set_header Host              $host;
		proxy_set_header X-Forwarded-Proto $scheme;
		proxy_read_timeout 300s;
	}
}
```

Then set `PUBLIC_URL=https://kern.example.com` and restart, because invite
links, share links and stream endpoints are built from it. `kernctl health`
checks that `PUBLIC_URL` matches what the proxy actually serves.

### Without a certificate

If you have no hostname, reach the server over an SSH tunnel and treat it as
local:

```sh
ssh -L 8787:127.0.0.1:8787 you@server
```

Kern will then sign in to `http://127.0.0.1:8787`, because that genuinely is
this machine. It refuses plain HTTP to a public address: the session and
everything synced would cross the internet in the clear. A private network
(`192.168.x`, `10.x`, `.local`) is allowed but says so.

## Who may sign up

`REGISTRATION` decides, and it is a live setting — change it from Kern Platform
or `kernctl set registration open` and apps see the difference on their next
sign-in screen, with no restart.

| | |
|---|---|
| `open` | Anyone who can reach the server. Optionally limited to certain email domains with `ALLOWED_EMAIL_DOMAINS`. |
| `invite` | Only an address holding a workspace invitation, or one an administrator added. **The default.** |
| `closed` | Nobody new. |

The very first account is always allowed, whatever this says, so a server you
have just installed is usable.

With `invite`, let somebody in without a workspace invitation:

```sh
kernctl allow add alice@example.com "new starter"
kernctl allow list
```

`MAX_USERS` caps how many accounts the instance will hold; `0` means no limit.

## Mail

Without SMTP, verification codes and invitations are **printed to the server
log** instead of sent. That is workable for a server only you use — read the
log, or skip the step entirely:

```sh
kernctl users verify alice@example.com
```

But nobody else can finish signing up, so set SMTP before inviting anyone:

```sh
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false        # true for implicit TLS on 465
SMTP_USER=kern@example.com
SMTP_PASS=…
MAIL_FROM=Kern <no-reply@example.com>
```

`kernctl health` reports mail as a warning while it is unset, and the app's
sign-in screen tells people this server can't send them a code. The
`/instance` reply carries `features.email`, so apps know before they try.

## Managing it

Both clients speak the same management API, `/kern/v1/admin/*`. Anything one
can do the other can.

**Kern Platform**, the desktop app in [`platform/`](../platform): health,
people, spaces, streams, settings, logs, the audit trail, a read-only SQL
console. On the server, run `kernctl pair` and paste the line it prints.

**`kernctl`**, in [`cli/`](../cli): the same surface in a terminal. On the
server's own machine it needs no setup — it reads the token from
`ADMIN_TOKEN_FILE`. Configuration is consulted in this order:

```
--url / --token              on the command line
KERN_URL / KERN_ADMIN_TOKEN  in the environment
~/.config/kernctl/config     written by `kernctl use`
/etc/kernctl/config          system-wide, written by the installer
the token file               ADMIN_TOKEN_FILE, or /var/lib/kern/admin-token
http://127.0.0.1:8787        the default
```

From your laptop, forward the port and remember it:

```sh
ssh -L 8787:127.0.0.1:8787 you@server
kernctl use http://127.0.0.1:8787 --token kern_…
```

### Opening the management API to the network

`ADMIN_LOCAL_ONLY=true` is the default, and it means nothing on the network can
even attempt a token. Only relax it if a tunnel genuinely won't do:

```sh
ADMIN_LOCAL_ONLY=false
ADMIN_ALLOW_FROM=192.168.1.0/24
```

The client address is taken from the socket, not from a header — a proxy header
is attacker-controlled and trusting one would undo the check. So putting the
management API behind a reverse proxy means **the proxy** is what is on the
allow list, and you must restrict who reaches it there instead.

### Management tokens

A token reads `kern_<id>_<secret>`, and only the hash of the secret half is
stored: a stolen database yields no working tokens. The whole token is shown
once, when it is created.

```sh
kernctl token list
kernctl token new "monitoring" --read --days 90
kernctl token revoke <id>
```

A `read` token can look at everything and change nothing, which is what a
monitoring check should hold. Everything that changes something is recorded in
the audit trail with the token that did it:

```sh
kernctl audit 50
```

Nothing in the management API reads anybody's work. It counts records, measures
spaces and lists who belongs to what; it never returns the contents of a task,
note or whiteboard. A leaked management token is bad — it is not a way to read
the data.

## Keeping it healthy

```sh
kernctl health          # every check, grouped: database, security, config, mail, storage
kernctl health --fix    # and repair what can be repaired
kernctl heal            # repair everything, then check again
kernctl doctor          # this machine, and the path to the server
```

Checks cover the database and its migrations, the connection pool, the two
secrets, whether `PUBLIC_URL` matches reality, whether the management API is
exposed, management tokens, mail, expired sessions and verifications, stale
invitations, unused whiteboard images, the stream log, spaces deleted more than
30 days ago, workspaces that have lost their owner, record sequence integrity,
orphaned records and table sizes.

The repairable ones are safe by construction: they delete what has already
expired or lost its parent. `kernctl health --fix=<id>` runs one of them.

For a monitoring check, `--json` and the exit code are enough — no `python3`,
no parsing:

```sh
kernctl health --json >/dev/null || echo "kern unhealthy"   # exit 4 when failing
```

`GET /kern/v1/health` is public and unauthenticated: it checks the database and
reports realtime figures, which is what a load balancer wants.

## Backups

```sh
kernctl backup /srv/backups/kern-$(date +%F).sql.gz
kernctl restore /srv/backups/kern-2026-10-21.sql.gz
```

`pg_dump`, gzipped. Back up three things, not one:

1. **The database.** Everything people have synced.
2. **`.env`.** Specifically `STREAMS_ENCRYPTION_KEY` — without it, restored
   stream secrets, GitHub tokens and Turnstile keys are unreadable, and
   `BETTER_AUTH_SECRET`, without which everyone is signed out.
3. **The management token file**, if you have no other copy of a token.

A nightly cron, keeping two weeks:

```sh
0 3 * * * /usr/local/bin/kernctl backup /srv/backups/kern-$(date +\%F).sql.gz && \
          find /srv/backups -name 'kern-*.sql.gz' -mtime +14 -delete
```

Restoring replaces the database. Clients notice: a space whose record sequence
has gone backwards is restored from the server on the app's next sync, which is
the right outcome but means changes made after the backup are gone.

## Upgrading

```sh
kernctl service upgrade        # docker: rebuild and restart
```

Or by hand:

```sh
cd /opt/kern && git pull
docker compose up -d --build
```

Native installs replace the files and restart:

```sh
cd /opt/kern/server && npm ci --omit=dev && npx tsc -p tsconfig.json
systemctl restart kern-server
```

Migrations run at startup. There is no separate migration step and no downtime
window to arrange for an ordinary upgrade.

**Protocol versions.** `/instance` reports a `protocol` number, and an app
refuses a server whose protocol is higher than the one it implements, saying so
plainly rather than failing later in a way nobody can diagnose. If you upgrade
the server past your apps, update the apps. See
[PROTOCOL.md](PROTOCOL.md#the-handshake).

## Troubleshooting

**The app says it can't reach the server.** Check the server answers at all:
`curl -s http://127.0.0.1:8787/kern/v1/health`. If that works and the app
can't, it is the proxy or TLS between them.

**Sync works but collaborators' edits never appear.** The realtime socket isn't
getting through. Almost always a reverse proxy not passing `Upgrade` and
`Connection` — see [nginx](#nginx) above.

**"Kern won't sign in over plain HTTP."** The address isn't loopback or a
private network, so the session would cross the internet in the clear. Use
https://, or an SSH tunnel.

**"That answered, but it isn't a Kern server."** Something replied at that
address without `service: "kern-cloud"` — usually a proxy's own error page, or
the wrong port.

**Nobody receives a verification code.** No SMTP: the code is in the log.
`docker compose logs api`, or `kernctl logs`. Or
`kernctl users verify <email>`.

**The management API refuses me.** `admin_local_only` means the address list
refused you, not your token. Connect over loopback or a tunnel.

**Logs are empty after a restart.** `kernctl logs` reads a ring buffer in the
server's memory (`ADMIN_LOG_LINES`), so a restart clears it. For history, read
the process log: `docker compose logs api` or `journalctl -u kern-server`.

## Uninstalling

```sh
sudo ./cli/install.sh --uninstall           # stop and remove the service
sudo ./cli/install.sh --uninstall --purge   # and the data
```

Without `--purge` the database and `.env` are left where they are, so you can
reinstall onto them.
