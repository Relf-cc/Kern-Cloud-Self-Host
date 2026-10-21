#!/bin/sh
# Install a self-hosted Kern server on Linux.
#
#   curl -fsSL https://.../install.sh | sudo sh
#   sudo ./cli/install.sh --url https://api.relf.cc --name "Relf"
#
# Two shapes, and it picks for you:
#
#   docker   PostgreSQL and the API as containers, managed by docker compose.
#            The default when Docker is installed. Nothing else is needed and
#            upgrades are one command.
#   native   Node builds the server, systemd runs it, and you bring your own
#            PostgreSQL. For a machine that already has both, or where Docker
#            isn't wanted.
#
# What it does, in order: check the machine, pick a shape, generate the
# secrets, write .env, start the server, install kernctl, wait for the server
# to answer, and print the one command that connects Kern Platform to it.
#
# It is safe to run twice: an existing .env keeps its secrets, so re-running
# upgrades rather than resetting. Nothing is written outside the install
# directory, /etc/kernctl, /usr/local/bin/kernctl and (native only) the
# systemd unit.

set -eu

VERSION="1.0.0"
PROG="$(basename "$0")"
# Kept for the "try sudo" message, before the option loop consumes them.
ORIGINAL_ARGS="$*"

# -------------------------------------------------------------------- options

DIR="/opt/kern"
PUBLIC_URL=""
INSTANCE_NAME=""
REGISTRATION="invite"
MODE=""
SOURCE=""
SERVICE_USER="kern"
PORT="8787"
ASSUME_YES=0
UNINSTALL=0
PURGE=0

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_DIM='\033[2m'; C_B='\033[1m'; C_OK='\033[32m'; C_WARN='\033[33m'; C_ERR='\033[31m'; C_OFF='\033[0m'
else
  C_DIM=''; C_B=''; C_OK=''; C_WARN=''; C_ERR=''; C_OFF=''
fi

say() { printf '%b\n' "$*"; }
step() { printf '%b\n' "${C_B}==>${C_OFF} $*"; }
note() { printf '%b\n' "    ${C_DIM}$*${C_OFF}"; }
warn() { printf '%b\n' "${C_WARN}!   $*${C_OFF}" >&2; }
die() { printf '%b\n' "${C_ERR}$*${C_OFF}" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

usage() {
  cat <<USAGE
$PROG $VERSION - install a self-hosted Kern server

  sudo $PROG [options]

Options
  --dir PATH            where to install              (default $DIR)
  --url URL             the address people will use    (default http://<ip>:$PORT)
  --name TEXT           what the instance calls itself (default the hostname)
  --registration MODE   open | invite | closed         (default $REGISTRATION)
  --port N              the port the API listens on    (default $PORT)
  --mode docker|native  how to run it                  (default: docker if present)
  --source PATH|URL     where to get the code from     (default: this checkout)
  --user NAME           service account, native mode   (default $SERVICE_USER)
  --yes                 don't ask anything
  --uninstall [--purge] remove the service (and, with --purge, the data)
  --help

Afterwards
  kernctl status        check on it
  kernctl heal          run every check and repair what it can
  kernctl pair          an address and token for Kern Platform, in one paste
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="${2:?--dir needs a path}"; shift ;;
    --url) PUBLIC_URL="${2:?--url needs an address}"; shift ;;
    --name) INSTANCE_NAME="${2:?--name needs a name}"; shift ;;
    --registration) REGISTRATION="${2:?--registration needs open, invite or closed}"; shift ;;
    --port) PORT="${2:?--port needs a number}"; shift ;;
    --mode) MODE="${2:?--mode needs docker or native}"; shift ;;
    --source) SOURCE="${2:?--source needs a path or URL}"; shift ;;
    --user) SERVICE_USER="${2:?--user needs a name}"; shift ;;
    --yes|-y) ASSUME_YES=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --purge) PURGE=1 ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; die "Unknown option: $1" ;;
  esac
  shift
done

case "$REGISTRATION" in
  open|invite|closed) ;;
  *) die "--registration takes open, invite or closed." ;;
esac

# ------------------------------------------------------------------ preflight

require_root() {
  [ "$(id -u)" = "0" ] || die "$PROG needs root, because it creates a service.

Try:  sudo $0 $ORIGINAL_ARGS"
}

detect_os() {
  OS_NAME="linux"
  OS_ID=""
  if [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    OS_ID="$(sed -n 's/^ID=\(.*\)$/\1/p' /etc/os-release | tr -d '"' | head -1)"
    OS_NAME="$(sed -n 's/^PRETTY_NAME=\(.*\)$/\1/p' /etc/os-release | tr -d '"' | head -1)"
  fi
  [ -n "$OS_NAME" ] || OS_NAME="$(uname -s)"
  ARCH="$(uname -m)"
}

# Installs packages, if we recognise the distribution. Never upgrades anything
# else: a server install script that runs a full system upgrade is rude.
install_packages() {
  [ $# -gt 0 ] || return 0
  step "Installing: $*"
  case "$OS_ID" in
    debian|ubuntu|raspbian|linuxmint|pop)
      DEBIAN_FRONTEND=noninteractive apt-get update -qq
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" ;;
    fedora|rhel|centos|rocky|almalinux)
      if have dnf; then dnf install -y -q "$@"; else yum install -y -q "$@"; fi ;;
    arch|manjaro) pacman -Sy --noconfirm --needed "$@" ;;
    alpine) apk add --no-cache "$@" ;;
    opensuse*|sles) zypper -n install "$@" ;;
    *) warn "Don't know how to install packages on $OS_NAME. Install these yourself: $*"; return 1 ;;
  esac
}

random_secret() {
  # openssl if it's there; /dev/urandom if not. Both give 32+ random bytes.
  bytes="${1:-32}"
  if have openssl; then
    openssl rand -base64 "$bytes" | tr -d '\n'
  else
    head -c "$bytes" /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

guess_url() {
  ip=""
  if have hostname; then ip="$(hostname -I 2>/dev/null | awk '{print $1}')"; fi
  if [ -z "$ip" ] && have ip; then ip="$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.*src \([0-9.]*\).*/\1/p')"; fi
  [ -z "$ip" ] && ip="localhost"
  printf 'http://%s:%s' "$ip" "$PORT"
}

ask() {
  # ask PROMPT DEFAULT -> answer on stdout
  prompt="$1"
  default="$2"
  if [ "$ASSUME_YES" = 1 ] || [ ! -t 0 ]; then
    printf '%s' "$default"
    return 0
  fi
  printf '%b' "    ${C_B}$prompt${C_OFF} [${default}]: " >&2
  read -r answer || answer=""
  printf '%s' "${answer:-$default}"
}

# ----------------------------------------------------------------- uninstall

do_uninstall() {
  require_root
  detect_os
  step "Removing the Kern server"
  if [ -f "$DIR/docker-compose.yml" ] && have docker; then
    ( cd "$DIR" && (docker compose down 2>/dev/null || docker-compose down 2>/dev/null || true) )
    say "    stopped the compose project"
  fi
  if have systemctl && systemctl list-unit-files 2>/dev/null | grep -q '^kern-server\.service'; then
    systemctl disable --now kern-server 2>/dev/null || true
    rm -f /etc/systemd/system/kern-server.service
    systemctl daemon-reload
    say "    removed the systemd unit"
  fi
  rm -f /usr/local/bin/kernctl
  rm -rf /etc/kernctl
  say "    removed kernctl"
  if [ "$PURGE" = 1 ]; then
    say ""
    warn "--purge will delete $DIR, including the database and every account on it."
    if [ "$ASSUME_YES" != 1 ]; then
      printf '%b' "    Type ${C_B}delete everything${C_OFF} to confirm: "
      read -r answer
      [ "$answer" = "delete everything" ] || die "Left alone. $DIR is untouched."
    fi
    rm -rf "$DIR"
    say "${C_OK}    deleted $DIR${C_OFF}"
  else
    say ""
    note "$DIR is still there, with the database and your .env."
    note "Run again with --purge to delete it."
  fi
  say ""
  say "${C_OK}Done.${C_OFF}"
  exit 0
}

[ "$UNINSTALL" = 1 ] && do_uninstall

# --------------------------------------------------------------------- source
#
# The code comes from the checkout this script is in, when there is one. That
# is the normal case: you cloned the repository and ran cli/install.sh.

find_source() {
  if [ -n "$SOURCE" ]; then
    case "$SOURCE" in
      http://*|https://*|git@*)
        have git || install_packages git || die "Need git to clone $SOURCE."
        tmp="$(mktemp -d)"
        step "Cloning $SOURCE"
        git clone --depth 1 "$SOURCE" "$tmp/src" >/dev/null 2>&1 || die "Couldn't clone $SOURCE."
        SRC="$tmp/src"
        ;;
      *)
        [ -d "$SOURCE" ] || die "$SOURCE isn't a directory."
        SRC="$SOURCE"
        ;;
    esac
  else
    here="$(cd "$(dirname "$0")" && pwd)"
    if [ -f "$here/../docker-compose.yml" ] && [ -d "$here/../server/src" ]; then
      SRC="$(cd "$here/.." && pwd)"
    else
      die "Can't find the Kern source.

Run this from a checkout:
  git clone <repository> kern-self-host
  cd kern-self-host
  sudo ./cli/install.sh

Or point at one:
  sudo $PROG --source /path/to/kern-self-host"
    fi
  fi
  [ -d "$SRC/server/src" ] || die "$SRC doesn't look like the Kern self-host repository (no server/src)."
}

# ---------------------------------------------------------------------- start

require_root
detect_os
find_source

say ""
say "${C_B}Kern self-host installer${C_OFF} $VERSION"
say "${C_DIM}  $OS_NAME ($ARCH)${C_OFF}"
say "${C_DIM}  source: $SRC${C_OFF}"
say ""

# ------------------------------------------------------------------ pick mode

if [ -z "$MODE" ]; then
  if have docker && (docker compose version >/dev/null 2>&1 || have docker-compose); then
    MODE="docker"
  elif [ -f "$DIR/docker-compose.yml" ]; then
    MODE="docker"
  elif have node; then
    MODE="native"
  else
    MODE="docker"
  fi
fi

step "Shape: $MODE"
case "$MODE" in
  docker)
    if ! have docker; then
      note "Docker isn't installed."
      if [ "$(ask 'Install Docker now? (yes/no)' yes)" = "yes" ]; then
        case "$OS_ID" in
          debian|ubuntu|raspbian|linuxmint|pop) install_packages docker.io docker-compose-plugin || install_packages docker.io ;;
          alpine) install_packages docker docker-cli-compose && rc-update add docker default 2>/dev/null || true ;;
          *) install_packages docker ;;
        esac
        have docker || die "Docker still isn't available. Install it, then run this again."
        systemctl enable --now docker 2>/dev/null || service docker start 2>/dev/null || true
      else
        die "Install Docker, or use --mode native."
      fi
    fi
    docker compose version >/dev/null 2>&1 || have docker-compose || die "Docker is installed but compose isn't. Install the docker compose plugin, or use --mode native."
    ;;
  native)
    have node || install_packages nodejs npm || die "Need Node 20 or newer. Install it, then run this again."
    node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    [ "$node_major" -ge 20 ] 2>/dev/null || die "Node $node_major is too old; the server needs 20 or newer."
    have npm || install_packages npm || die "Need npm."
    have psql || warn "psql isn't installed, so this script can't create the database for you."
    ;;
  *) die "--mode takes docker or native." ;;
esac

have curl || install_packages curl || warn "curl isn't installed; kernctl needs it."
have openssl || install_packages openssl || note "No openssl; secrets will come from /dev/urandom."

# ------------------------------------------------------------------- settings

[ -n "$PUBLIC_URL" ] || PUBLIC_URL="$(guess_url)"
[ -n "$INSTANCE_NAME" ] || INSTANCE_NAME="$(hostname 2>/dev/null || echo 'Kern Self-Host')"

ENV_FILE="$DIR/.env"
FRESH=1
[ -f "$ENV_FILE" ] && FRESH=0

if [ "$FRESH" = 1 ] && [ -t 0 ] && [ "$ASSUME_YES" != 1 ]; then
  say ""
  step "A few questions"
  INSTANCE_NAME="$(ask 'What should this instance call itself?' "$INSTANCE_NAME")"
  PUBLIC_URL="$(ask 'What address will people use to reach it?' "$PUBLIC_URL")"
  REGISTRATION="$(ask 'Who may sign up? (open/invite/closed)' "$REGISTRATION")"
  case "$REGISTRATION" in
    open|invite|closed) ;;
    *) die "Sign-ups must be open, invite or closed." ;;
  esac
fi

say ""
step "Installing to $DIR"
mkdir -p "$DIR" "$DIR/data/kern" "$DIR/data/postgres"

# Copy the code in. Everything that isn't the source itself is left alone, so
# .env and data/ survive a re-run.
step "Copying the server"
mkdir -p "$DIR/server"
if have rsync; then
  rsync -a --delete --exclude node_modules --exclude dist "$SRC/server/" "$DIR/server/"
else
  rm -rf "$DIR/server"
  mkdir -p "$DIR/server"
  ( cd "$SRC/server" && tar cf - --exclude node_modules --exclude dist . ) | ( cd "$DIR/server" && tar xf - )
fi
cp "$SRC/Dockerfile" "$SRC/docker-compose.yml" "$SRC/.env.example" "$DIR/" 2>/dev/null || true
cp -r "$SRC/docs" "$DIR/docs" 2>/dev/null || true
mkdir -p "$DIR/cli"
cp "$SRC/cli/kernctl" "$DIR/cli/kernctl"

# ----------------------------------------------------------------------- .env

if [ "$FRESH" = 1 ]; then
  step "Generating secrets"
  POSTGRES_PASSWORD="$(random_secret 24)"
  AUTH_SECRET="$(random_secret 48)"
  STREAMS_KEY="$(random_secret 32)"
  umask 077
  cat > "$ENV_FILE" <<ENVFILE
# Written by the Kern installer on $(date -u '+%Y-%m-%d %H:%M UTC').
#
# The secrets below are this instance's identity. Back this file up with your
# database dumps: without BETTER_AUTH_SECRET everyone must sign in again, and
# without STREAMS_ENCRYPTION_KEY stored stream credentials can't be read.
#
# Every other setting is documented in .env.example. The ones an administrator
# changes day to day (the name, who may sign up) are better changed with
# \`kernctl set\`, which takes effect without a restart.

PUBLIC_URL=$PUBLIC_URL
INSTANCE_NAME=$INSTANCE_NAME
REGISTRATION=$REGISTRATION
PORT=$PORT

POSTGRES_PASSWORD=$POSTGRES_PASSWORD
BETTER_AUTH_SECRET=$AUTH_SECRET
STREAMS_ENCRYPTION_KEY=$STREAMS_KEY

# The management API answers this machine only. Kern Platform connects over
# 127.0.0.1, or an SSH tunnel from your desktop.
ADMIN_LOCAL_ONLY=true
ADMIN_TOKEN_FILE=/var/lib/kern/admin-token

# No mail yet: verification codes go to the server log. Until you set these,
# confirm accounts with: kernctl users verify <email>
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
MAIL_FROM=Kern <no-reply@localhost>
ENVFILE
  if [ "$MODE" = "native" ]; then
    printf 'DATABASE_URL=postgres://kern:%s@127.0.0.1:5432/kern\n' "$POSTGRES_PASSWORD" >> "$ENV_FILE"
    printf 'ADMIN_TOKEN_FILE=/var/lib/kern/admin-token\n' >> "$ENV_FILE"
  fi
  chmod 600 "$ENV_FILE"
  umask 022
  say "    wrote $ENV_FILE ${C_DIM}(mode 600)${C_OFF}"
else
  step "Keeping the existing $ENV_FILE"
  note "Secrets and settings are untouched. Delete it to start over."
fi

# ---------------------------------------------------------------------- start

wait_for_health() {
  step "Waiting for the server"
  i=0
  while [ "$i" -lt 60 ]; do
    if curl -fsS --max-time 3 "http://127.0.0.1:$PORT/kern/v1/health" >/dev/null 2>&1; then
      say "    ${C_OK}answering on 127.0.0.1:$PORT${C_OFF}"
      return 0
    fi
    i=$((i + 1))
    sleep 1
  done
  warn "The server hasn't answered in 60 seconds."
  note "Look at why:  kernctl service logs"
  return 1
}

case "$MODE" in
  docker)
    step "Building and starting the containers"
    ( cd "$DIR" && (docker compose up -d --build || docker-compose up -d --build) )
    ;;
  native)
    step "Creating the service account"
    if ! id "$SERVICE_USER" >/dev/null 2>&1; then
      useradd --system --home-dir "$DIR" --shell /usr/sbin/nologin "$SERVICE_USER" 2>/dev/null ||
        adduser -S -H -h "$DIR" -s /sbin/nologin "$SERVICE_USER" 2>/dev/null ||
        warn "Couldn't create the user $SERVICE_USER; the service will run as root."
    fi
    mkdir -p /var/lib/kern
    chown -R "$SERVICE_USER:$SERVICE_USER" /var/lib/kern "$DIR" 2>/dev/null || true

    step "Building the server"
    ( cd "$DIR/server" && npm ci --omit=dev --silent && npm install --no-save typescript --silent && npx tsc -p tsconfig.json )

    step "Writing the systemd unit"
    cat > /etc/systemd/system/kern-server.service <<UNIT
[Unit]
Description=Kern self-hosted server
Documentation=file://$DIR/docs/SELF-HOSTING.md
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$DIR/server
EnvironmentFile=$DIR/.env
Environment=NODE_ENV=production
Environment=KERN_SERVER_VERSION=$VERSION
ExecStart=/usr/bin/env node dist/index.js
Restart=on-failure
RestartSec=5
# The server needs nothing but the network, its config and its token file.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/kern
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true

[Install]
WantedBy=multi-user.target
UNIT
    systemctl daemon-reload
    systemctl enable --now kern-server
    ;;
esac

# -------------------------------------------------------------------- kernctl

step "Installing kernctl"
install -m 0755 "$SRC/cli/kernctl" /usr/local/bin/kernctl 2>/dev/null || {
  cp "$SRC/cli/kernctl" /usr/local/bin/kernctl
  chmod 0755 /usr/local/bin/kernctl
}
mkdir -p /etc/kernctl
cat > /etc/kernctl/config <<KERNCTL
# Written by the Kern installer. kernctl reads this when nothing more specific
# is set; ~/.config/kernctl/config wins over it.
KERN_URL=http://127.0.0.1:$PORT
KERN_HOME=$DIR
KERN_SERVICE=$MODE
KERN_TOKEN_FILE=$([ "$MODE" = docker ] && printf '%s/data/kern/admin-token' "$DIR" || printf '/var/lib/kern/admin-token')
KERNCTL
chmod 644 /etc/kernctl/config
say "    /usr/local/bin/kernctl ${C_DIM}(config in /etc/kernctl/config)${C_OFF}"

# ----------------------------------------------------------------- the finish

say ""
wait_for_health || true

TOKEN_PATH="$([ "$MODE" = docker ] && printf '%s/data/kern/admin-token' "$DIR" || printf '/var/lib/kern/admin-token')"

say ""
say "${C_OK}${C_B}Kern is installed.${C_OFF}"
say ""
say "  Instance   ${C_B}$INSTANCE_NAME${C_OFF}"
say "  Address    ${C_B}$PUBLIC_URL/kern/v1${C_OFF}   ${C_DIM}(what people type into Kern)${C_OFF}"
say "  Sign-ups   $REGISTRATION"
say "  Directory  $DIR"
say "  Shape      $MODE"
say ""

if [ -r "$TOKEN_PATH" ]; then
  say "  ${C_DIM}Management token: $TOKEN_PATH - kernctl finds it there by itself.${C_OFF}"
else
  warn "No management token file at $TOKEN_PATH yet."
  note "It appears on first start. If the server printed one instead, keep it:"
  note "  kernctl service logs | head -40"
fi

say ""
say "${C_B}Next${C_OFF}"
say "  ${C_B}kernctl status${C_OFF}              see what it is doing"
say "  ${C_B}kernctl heal${C_OFF}                run every check and repair what it can"
say "  ${C_B}kernctl pair${C_OFF}                an address and token for Kern Platform"
if [ "$REGISTRATION" = "invite" ]; then
  say "  ${C_B}kernctl allow add you@relf.cc${C_OFF}"
  say "                              ${C_DIM}let yourself sign up (the first account is always allowed)${C_OFF}"
fi
say ""
say "${C_B}Then, in Kern${C_OFF}"
say "  Settings → Cloud → Add a server, and give it ${C_B}$PUBLIC_URL/kern/v1${C_OFF}"
say ""
case "$PUBLIC_URL" in
  https://*) ;;
  *)
    warn "$PUBLIC_URL is plain HTTP."
    note "Anyone else syncing to it would send their session token unencrypted."
    note "Put it behind TLS before other people use it: $DIR/docs/SELF-HOSTING.md"
    say ""
    ;;
esac
if grep -q '^SMTP_HOST=$' "$ENV_FILE" 2>/dev/null; then
  note "No SMTP yet: verification codes go to the server log."
  note "On a single-person instance, use  kernctl users verify <email>  instead."
  say ""
fi
