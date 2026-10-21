# Self-hosting Kern

Everything you need to run the server, keep it running, and let other people
sync to it safely.

- [What you need](#what-you-need)
- [The two hostnames](#the-two-hostnames)
- [Installing](#installing)
- [Putting it on the internet](#putting-it-on-the-internet)
- [Who may sign up](#who-may-sign-up)
- [Who may create a workspace](#who-may-create-a-workspace)
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
- **A hostname**, if anybody but you will use it, and one of:
  - a **Cloudflare account** with that domain's zone, for a tunnel — no open
    port, no certificate on the server, no public IP needed; or
  - a **TLS certificate** and a port reachable from the internet, for a
    reverse proxy.

One person syncing their own devices is a very small load: a server with 1 GB
of memory is plenty. What grows is the database, and what grows fastest in it
is whiteboard images — see `ASSET_QUOTA_MB` in [`.env.example`](../.env.example).

## The two hostnames

This instance is served on two names, both pointing at the same machine and the
same single process:

| | | |
|---|---|---|
| `api.relf.cc` | `PUBLIC_URL` | The API the Kern app talks to (`/kern/v1/*`), the realtime socket, sign-in, and — unless `LINK_URL` says otherwise — invite links, share pages and calendar feeds. |
| `streams.relf.cc` | `STREAMS_URL` | Stream endpoints (`/kern/<64 hex>`) and their phone capture pages. |

The split is in the URLs the server hands out, not in where it listens. One
process answers both; `STREAMS_URL` only decides which origin a new stream's
endpoint is published as. The point is that an address pasted into a form, a
webhook or a third-party tool never carries the hostname people sign in on, so
a stream endpoint can be handed out, rotated or taken away without exposing
the API host.

Because the server routes on the path and not the `Host` header, every route is
reachable on either name unless whatever is in front narrows it. The tunnel
ingress rules below narrow it: `streams.relf.cc` serves only stream paths, and
the management API is served on neither.

### DNS

This instance is reached through a Cloudflare Tunnel, so there are **no `A`
records and no origin IP in DNS at all**. `cloudflared tunnel route dns` writes
a proxied `CNAME` for each name, pointing at the tunnel:

```
api.relf.cc.      CNAME  <tunnel-uuid>.cfargotunnel.com   (proxied)
streams.relf.cc.  CNAME  <tunnel-uuid>.cfargotunnel.com   (proxied)
```

Both records must stay **proxied** (orange cloud) — a tunnel only works through
Cloudflare's edge, and `cfargotunnel.com` does not resolve publicly. Cloudflare
terminates TLS and its Universal SSL certificate already covers a first-level
subdomain like these two, so there is nothing to issue or renew on the server.

Check both from off the machine once the tunnel is up:

```sh
dig +short api.relf.cc streams.relf.cc    # Cloudflare edge addresses
curl -s https://api.relf.cc/kern/v1/health
```

Not using Cloudflare? [Caddy and nginx](#a-reverse-proxy-instead) are the
alternative, and then these are ordinary `A` records to the server with
certificates issued on it.

Email to streams needs one more name and an `MX`; see [Mail](#mail).

## Installing

### The installer

```sh
sudo ./cli/install.sh --url https://api.relf.cc --name "Relf"
```

It checks the machine, picks a shape, generates the secrets, writes `.env`,
starts the server, installs `kernctl`, waits for the server to answer, and
prints the one line that connects Kern Platform to it.

`--url` sets `PUBLIC_URL` only. The installer has no flag for the streams
hostname, so add it to `.env` afterwards and restart — before creating any
stream, since endpoints are built when the stream is made:

```sh
echo 'STREAMS_URL=https://streams.relf.cc' | sudo tee -a /opt/kern/.env
sudo systemctl restart kern-server        # native mode
# docker mode: cd /opt/kern && sudo docker compose up -d
```

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

Generate the three secrets; the addresses are already in the file:

```sh
POSTGRES_PASSWORD=$(openssl rand -hex 24)
BETTER_AUTH_SECRET=$(openssl rand -base64 48)
STREAMS_ENCRYPTION_KEY=$(openssl rand -base64 32)
```

**`POSTGRES_PASSWORD` must be hex, not base64.** `docker-compose.yml` builds
`DATABASE_URL` as `postgres://kern:<password>@db:5432/kern`, and a `/` — which
base64 produces about 40% of the time — ends the URL's authority early and
leaves an invalid port. The API then dies at startup with `ERR_INVALID_URL`
while PostgreSQL itself stays healthy, which reads like a database problem and
is not one. The other two are never put in a URL, so base64 is fine for them.

`PUBLIC_URL=https://api.relf.cc` and `STREAMS_URL=https://streams.relf.cc` are
already set by `.env.example`; change them only if you are running a different
instance.

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

## Putting it on the internet

`docker-compose.yml` publishes the API on `127.0.0.1:8787` and nothing else.
That is the whole shape of the deployment: **do not change it to `0.0.0.0`.**
Something else fronts it, and there are two ways:

| | |
|---|---|
| **[A Cloudflare Tunnel](#cloudflare-tunnel)** | What this instance uses. `cloudflared` dials out from the server, so no inbound port is opened, no certificate lives on the box and no origin IP appears in DNS. |
| **[A reverse proxy](#a-reverse-proxy-instead)** | Caddy or nginx on the server, with its own certificate and a port open to the internet. |

Either way the server needs one thing beyond ordinary forwarding: the realtime
socket is a WebSocket upgrade, so whatever is in front must pass it through.

### Cloudflare Tunnel

`cloudflared` runs on the server, makes an outbound connection to Cloudflare,
and Cloudflare routes the two hostnames down it. Nothing listens on a public
port, and the API stays bound to loopback exactly as it ships.

#### Locally or remotely managed

A tunnel keeps its routing in one of two places, and the choice decides where
the rules below live:

| | |
|---|---|
| **Locally managed** | Routing lives in `/etc/cloudflared/config.yml` on the server. Created with `cloudflared tunnel create`, run with a credentials file. |
| **Remotely managed** | Routing lives in Cloudflare's dashboard. Created in the dashboard, installed with `cloudflared service install <token>`. |

**Prefer locally managed for this server.** One of the rules below is the only
thing keeping the management API off the internet, and in a file it is exact,
reviewable, version-controllable and deterministic in its ordering. Cloudflare
documents the config file's `path` as a Go regular expression; it does not
document how the dashboard's path field matches or how its routes order, which
is a poor footing for a rule that matters this much.

If you already installed with a token, see
[a remotely-managed tunnel](#a-remotely-managed-tunnel-instead) — it is
workable, it just puts the same refusals somewhere else.

#### Setting it up

Install it and authenticate against the `relf.cc` zone:

```sh
sudo mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt update && sudo apt install cloudflared

# Only for a locally-managed tunnel. With a token you skip both of these.
sudo cloudflared tunnel login      # opens a browser; authorise the relf.cc zone
sudo cloudflared tunnel create kern
```

`tunnel create` prints the tunnel's UUID and writes its credentials to
`/root/.cloudflared/<uuid>.json`. **Back that file up** — it is the tunnel's
identity, and losing it means creating a new tunnel and repointing DNS.

Point both names down it. This writes the proxied `CNAME` records for you:

```sh
sudo cloudflared tunnel route dns kern api.relf.cc
sudo cloudflared tunnel route dns kern streams.relf.cc
```

#### The ingress rules

`/etc/cloudflared/config.yml`. **Order matters** — rules are matched top to
bottom and the first hit wins. So the management API's refusal goes *before*
the rule that would otherwise serve it, and each hostname's catch-all goes
*after* the specific rules for that name:

```yaml
tunnel: <uuid>
credentials-file: /root/.cloudflared/<uuid>.json

ingress:
  # 1. The management API, refused. This rule is load-bearing; see below.
  - hostname: api.relf.cc
    path: "^/kern/v1/admin(/.*)?$"
    service: http_status:404

  # 2. The app: API, sign-in, realtime socket, invite and share links.
  - hostname: api.relf.cc
    service: http://127.0.0.1:8787

  # 3. Stream endpoints, capture pages, and a capture page's icon and manifest.
  - hostname: streams.relf.cc
    path: "^/kern/[0-9a-f]{64}(/capture(/.*)?)?$"
    service: http://127.0.0.1:8787

  # 4. Anything else on the streams name.
  - hostname: streams.relf.cc
    service: http_status:404

  # 5. Required catch-all: any other hostname pointed at this tunnel.
  - service: http_status:404
```

Validate it, then run it as a service:

```sh
sudo cloudflared tunnel ingress validate
sudo cloudflared service install          # no token: reads the config file
sudo systemctl enable --now cloudflared
sudo systemctl status cloudflared
journalctl -u cloudflared -f
```

#### A remotely-managed tunnel instead

Created in the dashboard and installed with its token:

```sh
sudo cloudflared service install <token>
sudo systemctl enable --now cloudflared
```

The token carries the account, the tunnel id and the tunnel's secret, so
**treat it as a credential**: anyone holding it can run a connector for this
tunnel. It is not a config file — routing comes from Cloudflare, so rules 1 to 4
above have to be recreated as routes under **Networks → Tunnels →** your tunnel
**→ Published application**, in this order. (Rule 5, the catch-all for any other
hostname, has no dashboard equivalent and is not needed: a hostname with no
route was never pointed at this tunnel.)

| # | Hostname | Path | Service |
|---|---|---|---|
| 1 | `api.relf.cc` | `^/kern/v1/admin(/.*)?$` | `HTTP_STATUS` → `404` |
| 2 | `api.relf.cc` | *(none)* | `HTTP` → `127.0.0.1:8787` |
| 3 | `streams.relf.cc` | `^/kern/[0-9a-f]{64}(/capture(/.*)?)?$` | `HTTP` → `127.0.0.1:8787` |
| 4 | `streams.relf.cc` | *(none)* | `HTTP_STATUS` → `404` |

Then **enforce the management-API refusal with a WAF rule as well**, and treat
that as the real control rather than row 1:

```
Field:    URI Path
Operator: starts with
Value:    /kern/v1/admin
Action:   Block
```

That is belt and braces on a locally-managed tunnel. Here it is the load-bearing
part, because Cloudflare documents neither how the dashboard's path field
matches (the config file's `path` is a Go regular expression; the dashboard's is
not specified) nor how its routes are ordered — so row 1 cannot be relied on to
win over row 2 the way rule 1 provably wins in a file. The WAF rule runs at the
edge, before the tunnel, and its semantics are documented.

Verify both, from off the server:

```sh
curl -s -o /dev/null -w '%{http_code}\n' https://api.relf.cc/kern/v1/admin/stats  # 403 or 404
curl -s https://api.relf.cc/kern/v1/health                                 # {"ok":true,...}
curl -s -o /dev/null -w '%{http_code}\n' https://streams.relf.cc/                 # 404
```

A `200` on the first line means the management API is on the internet. Fix it
before going further.

To move a token-installed tunnel back to a file, delete the service, run
`cloudflared tunnel create` as above and reinstall without a token:

```sh
sudo cloudflared service uninstall
```

#### Why rule 1 is load-bearing

The management API is loopback-only by default (`ADMIN_LOCAL_ONLY=true`), and
the check is on the socket address rather than a header, because a header is
attacker-controlled. **`cloudflared` connects from `127.0.0.1`.** Every request
it forwards therefore arrives looking local and clears that gate, whoever on
the internet sent it — leaving a management token as the only thing in the way.

So on a tunnelled instance it is rule 1 that keeps `/kern/v1/admin/*` off the
internet, not `ADMIN_LOCAL_ONLY` — or, on a remotely-managed tunnel, the WAF
rule. Leave it in place, keep it first, and prove it after any change:

```sh
curl -s -o /dev/null -w '%{http_code}\n' https://api.relf.cc/kern/v1/admin/stats
# 404 — anything else means the rule is missing, misordered or misspelled
```

**In Docker this is not optional.** The API is published as
`127.0.0.1:8787:8787`, so requests reach the container through Docker's port
proxy and arrive from the bridge gateway rather than from loopback. `kernctl`
on the host and a request `cloudflared` forwards from the internet travel that
same hop and look identical to the server — there is no address rule that can
admit one and refuse the other. Whatever makes `kernctl` work makes the tunnel
work too, so the refusal has to happen before the server sees the request.

Which case you are in takes one command on the server:

```sh
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/kern/v1/admin/stats
```

| | |
|---|---|
| `401` | The address gate passed and only the token refused you — the server sees these requests as local. A tunnel route to this port would expose the management API. |
| `403` | The address gate refused you (`admin_local_only`). `kernctl` cannot reach it either; it needs `ADMIN_LOCAL_ONLY=false` and `ADMIN_ALLOW_FROM` set to the bridge gateway (`docker network inspect kern_default -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}'`) — and once it is, the first case applies. |

Either way the edge refusal is what keeps the management API private.

Belt and braces, if you want it: a Cloudflare WAF custom rule blocking
`http.request.uri.path contains "/kern/v1/admin"` refuses those requests at the
edge, before they reach the tunnel at all.

Managing the instance is unaffected: `kernctl` on the server's own machine and
Kern Platform over an SSH tunnel both reach `127.0.0.1:8787` directly, never
going near Cloudflare.

#### What the tunnel does and doesn't need

- **WebSockets** work with no configuration. Cloudflare closes an idle socket
  after roughly 100 seconds; the server pings every 30, so realtime
  collaboration stays up by itself.
- **Request size** is capped by Cloudflare at 100 MB on the free plan, far
  above `ASSET_MAX_BYTES` (3 MB) and `STREAM_MAX_BODY_BYTES` (256 KB).
- **Client addresses** arrive as `CF-Connecting-IP`, which is what the server
  reads for stream rate limits and sign-in records — so per-sender limits and a
  stream's address allowlist keep working. Without that header everything would
  look like one sender, the tunnel itself.
- **Caching** needs nothing. Cloudflare does not cache these responses by
  default, and no rule should be added that would.

### A reverse proxy instead

Not using Cloudflare? Put Caddy or nginx on the server, open 443, and issue
certificates there. The path narrowing that rules 1, 3 and 4 do above has to be
reproduced in the proxy, which is what these configurations do.

#### Caddy

Both names, one backend. Caddy gets the certificates itself and handles
WebSockets without being asked. The management API is refused on both names;
see [below](#opening-the-management-api-to-the-network) for why that matters.

```
api.relf.cc {
	# The management API must not be reachable from the internet. Caddy
	# connects to the server from 127.0.0.1, and the server allows loopback
	# unconditionally, so this refusal is the only thing keeping it off.
	@admin path /kern/v1/admin /kern/v1/admin/*
	handle @admin {
		respond 404
	}
	handle {
		reverse_proxy 127.0.0.1:8787
	}
}

# Stream endpoints and their capture pages only. Anything else on this name is
# refused, so the API is not reachable by a second address.
streams.relf.cc {
	# The endpoint, the capture page, and the capture page's icon and manifest.
	@streams path_regexp ^/kern/[0-9a-f]{64}(/capture(/.*)?)?$
	handle @streams {
		reverse_proxy 127.0.0.1:8787
	}
	handle {
		respond 404
	}
}
```

```sh
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

#### nginx

```nginx
# ---- the API, the realtime socket, invite and share links ----
server {
	listen 443 ssl;
	http2 on;
	server_name api.relf.cc;

	ssl_certificate     /etc/letsencrypt/live/api.relf.cc/fullchain.pem;
	ssl_certificate_key /etc/letsencrypt/live/api.relf.cc/privkey.pem;

	# Whiteboard images and stream submissions; see ASSET_MAX_BYTES.
	client_max_body_size 8m;

	# The management API must not be reachable from the internet. nginx
	# connects to the server from 127.0.0.1, and the server allows loopback
	# unconditionally, so this refusal is the only thing keeping it off.
	# "^~" wins over any regex location, whatever is added below.
	location ^~ /kern/v1/admin {
		return 404;
	}

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

# ---- stream endpoints and capture pages ----
server {
	listen 443 ssl;
	http2 on;
	server_name streams.relf.cc;

	ssl_certificate     /etc/letsencrypt/live/streams.relf.cc/fullchain.pem;
	ssl_certificate_key /etc/letsencrypt/live/streams.relf.cc/privkey.pem;

	# A submission is small; see STREAM_MAX_BODY_BYTES.
	client_max_body_size 1m;

	# A stream endpoint, its capture page, and the capture page's own icon
	# and web manifest. No API, no sign-in, no management, whatever anyone
	# guesses at this name.
	location ~ "^/kern/[0-9a-f]{64}(/capture(/.*)?)?$" {
		proxy_pass http://127.0.0.1:8787;
		proxy_http_version 1.1;
		proxy_set_header Host              $host;
		proxy_set_header X-Forwarded-Proto $scheme;
		proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
	}

	location / {
		return 404;
	}
}
```

```sh
sudo nginx -t && sudo systemctl reload nginx
```

#### Certificates

The two server blocks above read a separate certificate each, so issue one per
name:

```sh
sudo certbot certonly --nginx -d api.relf.cc
sudo certbot certonly --nginx -d streams.relf.cc
```

Order matters: nginx will not start while a `ssl_certificate` path does not
exist yet. Either issue both certificates first, with the names served over
plain HTTP, and add the TLS blocks afterwards — or let certbot write them for
you:

```sh
sudo certbot --nginx -d api.relf.cc -d streams.relf.cc
```

Renewal is certbot's own timer; `sudo certbot renew --dry-run` proves it works.
Caddy needs none of this — it obtains and renews both itself on first start.

### Then tell the server its own addresses

```sh
PUBLIC_URL=https://api.relf.cc
STREAMS_URL=https://streams.relf.cc
```

Restart after changing either. Sessions, invite links and share links are built
from `PUBLIC_URL`; a stream's published endpoint is built from `STREAMS_URL` when
the stream is created, so set it **before** creating streams — changing it later
does not rewrite endpoints already handed out, and the old host keeps serving
them as long as it resolves.

`kernctl health` checks that `PUBLIC_URL` is a public HTTPS origin rather than a
loopback or plain-HTTP one. Confirm the whole path end to end:

```sh
curl -s https://api.relf.cc/kern/v1/health         # {"ok":true,...}
curl -s https://api.relf.cc/kern/v1/instance       # name, features, apiUrl

# the streams host answers stream paths and nothing else
curl -s -o /dev/null -w '%{http_code}\n' https://streams.relf.cc/                 # 404
# and the management API is not on the internet at all
curl -s -o /dev/null -w '%{http_code}\n' https://api.relf.cc/kern/v1/admin/stats  # 404
```

Those last two are the point of the arrangement. Run them again after any
change to the tunnel's ingress rules or the proxy configuration.

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
kernctl allow add alice@relf.cc "new starter"
kernctl allow list
```

`MAX_USERS` caps how many accounts the instance will hold; `0` means no limit.

## Who may create a workspace

`REGISTRATION` decides who may have an account. This decides what they may do
with one, and it is a separate question on an instance you run for other
people: accounts are cheap, but a workspace is what costs you storage, mail
and attention.

```sh
WORKSPACE_KEYS=required
```

With it on, creating a workspace takes a key you minted and handed over.
Everything else is untouched — **the gate is on creation and nothing else**:

| | |
|---|---|
| Creating a workspace | Needs a key. |
| Accepting an invitation | Never does. Colleagues you invite need nothing. |
| Working in a workspace | Never does, once somebody is in one. |
| The personal space | Never does. It isn't a workspace. |

A key reads `k_` and 32 hex characters. Only its SHA-256 is stored, so the
table is worthless if it leaks, and it is shown exactly once when minted.
**A key is claimed by the first account that uses it** and refused to every
other one afterwards, so one key passed around does not become ten workspaces.
Once claimed, that account may keep using it, up to `WORKSPACES_PER_USER`.

```sh
kernctl keys new "Acme pilot"      # mints one, prints it once
kernctl keys list                  # who has claimed what
kernctl keys revoke <id>           # stops the next use
```

Revoking never unmakes a workspace already created with the key. It is the
same in Kern Platform, on the Keys page, which also has the switch.

Somebody refused is told what to do next: ask you for a key, or run their own
server with Kern Platform, which needs none.

### Managing keys without SSH

Handing out keys over SSH every time is not a life, so an account you name may
do it while signed in normally:

```sh
ADMIN_EMAILS=christianjamesrelf@gmail.com
```

Those accounts reach `/kern/v1/owner/*` with an ordinary session, through your
tunnel or proxy like the rest of the app API. **It is not the management API.**
It can list, mint and revoke workspace keys and turn the requirement on or off.
There is no fifth thing it can do: the SQL console, account deletion, logs and
backups stay on `/kern/v1/admin/*`, which remains loopback-only and must still
be refused at the edge — see [the ingress rules](#the-ingress-rules).

`ADMIN_EMAILS` is an environment value rather than a database column on
purpose. Granting it takes shell access on the server, so a compromised
database cannot promote anybody, and a restored backup cannot quietly carry an
administrator with it. Matching is exact and case-insensitive: no domains, no
wildcards. Changes need a restart.

In Kern Platform, that is the **Sign in with your account** button on the
welcome screen: the address, your email and your password. A server reached
that way shows the Keys page and nothing else, because that is all it will
answer — the rest of the app needs a management token and the server's own
machine. Signing out again is on the Servers page; it leaves the server in the
list and any management token untouched.

Every mint and revocation lands in the same audit trail as the management API
(`kernctl audit`), attributed to the account rather than to a token.

## Mail

Without SMTP, verification codes and invitations are **printed to the server
log** instead of sent. That is workable for a server only you use — read the
log, or skip the step entirely:

```sh
kernctl users verify alice@relf.cc
```

But nobody else can finish signing up, so set SMTP before inviting anyone:

```sh
SMTP_HOST=                       # the host your mail provider gives you
SMTP_PORT=587
SMTP_SECURE=false                # true for implicit TLS on 465
SMTP_USER=kern@relf.cc
SMTP_PASS=…
MAIL_FROM=Kern <no-reply@relf.cc>
SUPPORT_EMAIL=admin@relf.cc      # shown in emails as who to contact
```

`SMTP_HOST` is the only value that depends on who sends your mail, so it ships
empty rather than guessing. The addresses are on `relf.cc`, so whichever
provider you use, `relf.cc` needs the `SPF`, `DKIM` and `DMARC` records that
provider documents — without them verification codes land in spam, which looks
exactly like the server not sending them.

`kernctl health` reports mail as a warning while it is unset, and the app's
sign-in screen tells people this server can't send them a code. The
`/instance` reply carries `features.email`, so apps know before they try.

### Email to streams

A stream can have its own address, so forwarding an email creates a task. The
addresses live on their own subdomain, kept apart from the one that sends
account mail:

```sh
INBOUND_EMAIL_SECRET=$(openssl rand -base64 32)
INBOUND_EMAIL_DOMAIN=in.relf.cc
```

`in.relf.cc` needs an `MX` pointing at whatever receives the mail, and that
receiver runs `server/deploy/email-worker.js`, which posts what arrives to this
server with `INBOUND_EMAIL_SECRET` as the shared secret. Leave the secret empty
and the whole feature is off — no address is minted and nothing is accepted.

Each stream's address is `<20-character alias>@in.relf.cc`. The address is the
credential: anything that can send mail to it can file into that stream, so
treat it like a password and rotate the stream if it leaks. See
[streams.md](streams.md).

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

> **A tunnel or a proxy on the same machine defeats this check by itself.**
> `cloudflared`, Caddy and nginx all connect from `127.0.0.1`, and loopback is
> allowed unconditionally — `ADMIN_LOCAL_ONLY=true` does not change that,
> because the server cannot tell a forwarded request from a local one. Whatever
> is in front must refuse `/kern/v1/admin/*` itself. The
> [tunnel ingress rules](#the-ingress-rules) and the
> [proxy configurations](#a-reverse-proxy-instead) above both do.

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

**The API restarts forever and the log says `ERR_INVALID_URL`.** PostgreSQL is
healthy, the API container is `Restarting`, and the stack trace ends in
`pg-connection-string`. `POSTGRES_PASSWORD` contains a character that is not
safe in a URL — almost always a `/` from `openssl rand -base64`. Give it a hex
password instead, changing it in the database and in `.env` together:

```sh
NEW=$(openssl rand -hex 24)
docker compose exec db psql -U kern -d kern -c "ALTER USER kern WITH PASSWORD '$NEW';"
sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$NEW|" .env
docker compose up -d
```

Changing `POSTGRES_PASSWORD` in `.env` alone does **not** work once the
database exists: PostgreSQL keeps the password it was initialised with, so the
two must be changed together or the volume removed and the stack started again.

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
