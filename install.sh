#!/usr/bin/env bash
#
# VoiceMa installer for Debian / Ubuntu.
#
# Sets up the whole stack: Node.js, the app, a systemd service, nginx as a
# shared TLS front door, and a local CA so browsers trust the LAN address.
#
# The app is mounted under a sub-path (default /VoiceMa) so the same server can
# host other applications alongside it at their own paths.
#
#   sudo bash install.sh                                    interactive
#   sudo bash install.sh --yes                              accept every default
#   sudo bash install.sh --path /Voice --port 8471 --yes    scripted
#   sudo bash install.sh --uninstall                        remove service + nginx entry
#
set -euo pipefail

REPO_URL="https://github.com/RmaNMetaverse/VoiceMa"
APP_NAME="voicema"
APP_DIR="/opt/voicema"
SERVICE_USER="voicema"
NGINX_SITE="/etc/nginx/sites-available/lan-apps"
NGINX_LINK="/etc/nginx/sites-enabled/lan-apps"
NGINX_APPS_DIR="/etc/nginx/lan-apps.d"
NODE_MAJOR_MIN=18
NODE_MAJOR_INSTALL=20

# Defaults, overridable by flags or answers.
BASE_PATH="/VoiceMa"
APP_PORT="8471"
SERVER_NAME="VoiceMa"
SERVER_PASSWORD=""
CERT_HOSTS=""
ASSUME_YES=0
DO_UNINSTALL=0

# ----------------------------------------------------------------------------
# Output helpers
# ----------------------------------------------------------------------------

if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'
  YELLOW=$'\033[33m'; BLUE=$'\033[36m'; MAGENTA=$'\033[35m'; RESET=$'\033[0m'
else
  BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; BLUE=""; MAGENTA=""; RESET=""
fi

step()  { printf '\n%s==>%s %s%s%s\n' "$MAGENTA" "$RESET" "$BOLD" "$1" "$RESET"; }
info()  { printf '    %s\n' "$1"; }
ok()    { printf '    %s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
warn()  { printf '    %s!%s %s\n' "$YELLOW" "$RESET" "$1"; }
die()   { printf '\n%serror:%s %s\n\n' "$RED" "$RESET" "$1" >&2; exit 1; }

on_error() {
  local line=$1
  printf '\n%sInstallation failed on line %s.%s\n' "$RED" "$line" "$RESET" >&2
  printf 'Nothing else was changed. Check the output above, fix the cause, and re-run.\n' >&2
  printf 'Service logs, if it got that far:  journalctl -u %s -n 50 --no-pager\n\n' "$APP_NAME" >&2
}
trap 'on_error $LINENO' ERR

# ----------------------------------------------------------------------------
# Argument parsing
# ----------------------------------------------------------------------------

while [ $# -gt 0 ]; do
  case "$1" in
    --path)       BASE_PATH="${2:-}"; shift 2 ;;
    --port)       APP_PORT="${2:-}"; shift 2 ;;
    --name)       SERVER_NAME="${2:-}"; shift 2 ;;
    --password)   SERVER_PASSWORD="${2:-}"; shift 2 ;;
    --hosts)      CERT_HOSTS="${2:-}"; shift 2 ;;
    --repo)       REPO_URL="${2:-}"; shift 2 ;;
    -y|--yes)     ASSUME_YES=1; shift ;;
    --uninstall)  DO_UNINSTALL=1; shift ;;
    -h|--help)
      # Print the header comment block and stop at the first line of code.
      awk 'NR==1 {next} /^#/ {sub(/^# ?/, ""); print; next} {exit}' "$0"
      exit 0 ;;
    *) die "Unknown option: $1  (try --help)" ;;
  esac
done

# ----------------------------------------------------------------------------
# Prompts
# ----------------------------------------------------------------------------

ask() {
  # ask <variable> <question> <default>
  local __var=$1 question=$2 default=$3 answer=""
  if [ "$ASSUME_YES" = "1" ] || [ ! -t 0 ]; then
    printf '    %s %s%s%s\n' "$question" "$DIM" "$default" "$RESET"
    printf -v "$__var" '%s' "$default"
    return
  fi
  printf '    %s %s[%s]%s ' "$question" "$DIM" "$default" "$RESET"
  read -r answer </dev/tty || answer=""
  printf -v "$__var" '%s' "${answer:-$default}"
}

ask_secret() {
  local __var=$1 question=$2 answer=""
  if [ "$ASSUME_YES" = "1" ] || [ ! -t 0 ]; then
    printf -v "$__var" '%s' ""
    return
  fi
  printf '    %s %s(blank for none)%s ' "$question" "$DIM" "$RESET"
  read -rs answer </dev/tty || answer=""
  printf '\n'
  printf -v "$__var" '%s' "$answer"
}

confirm() {
  local question=$1 answer=""
  [ "$ASSUME_YES" = "1" ] && return 0
  [ ! -t 0 ] && return 0
  printf '    %s %s[Y/n]%s ' "$question" "$DIM" "$RESET"
  read -r answer </dev/tty || answer=""
  case "${answer:-y}" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

# Normalises a mount point to '' or '/Name' — the same shape the server expects.
normalize_path() {
  local p="${1:-}"
  p="${p#"${p%%[![:space:]]*}"}"; p="${p%"${p##*[![:space:]]}"}"
  p="$(printf '%s' "$p" | tr -s '/')"
  [ -z "$p" ] || [ "$p" = "/" ] && { printf ''; return; }
  p="/${p#/}"; p="${p%/}"
  printf '%s' "$p"
}

primary_ip() {
  ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}' \
    || hostname -I 2>/dev/null | awk '{print $1}'
}

port_in_use() {
  ss -ltn "( sport = :$1 )" 2>/dev/null | tail -n +2 | grep -q .
}

# ----------------------------------------------------------------------------
# Uninstall
# ----------------------------------------------------------------------------

if [ "$DO_UNINSTALL" = "1" ]; then
  [ "$(id -u)" = "0" ] || die "Run as root:  sudo $0 --uninstall"
  step "Removing VoiceMa"
  systemctl disable --now "$APP_NAME" 2>/dev/null || true
  rm -f "/etc/systemd/system/${APP_NAME}.service"
  systemctl daemon-reload
  rm -f "${NGINX_APPS_DIR}/${APP_NAME}.conf"
  nginx -t >/dev/null 2>&1 && systemctl reload nginx || true
  ok "Service and nginx location removed"
  info "Left in place on purpose: ${APP_DIR} (app + data + certs) and the user '${SERVICE_USER}'."
  info "Delete them yourself if you are sure:"
  info "  sudo rm -rf ${APP_DIR} && sudo userdel ${SERVICE_USER}"
  printf '\n'
  exit 0
fi

# ----------------------------------------------------------------------------
# Preflight
# ----------------------------------------------------------------------------

printf '\n%s' "$MAGENTA"
cat <<'BANNER'
 ┌──────────────────────────────────────────────────────────┐
 │  VoiceMa — LAN voice chat                                │
 │  installer for Debian / Ubuntu                           │
 └──────────────────────────────────────────────────────────┘
BANNER
printf '%s' "$RESET"

[ "$(id -u)" = "0" ] || die "Run as root:  sudo $0"
command -v apt-get >/dev/null 2>&1 || die "This installer needs apt-get (Debian, Ubuntu, or a derivative)."

. /etc/os-release 2>/dev/null || true
info "Detected: ${PRETTY_NAME:-unknown Linux} ($(uname -m))"

DETECTED_IP="$(primary_ip || true)"
[ -n "$DETECTED_IP" ] || DETECTED_IP="127.0.0.1"

# ----------------------------------------------------------------------------
# Questions
# ----------------------------------------------------------------------------

step "Configuration"

ask BASE_PATH   "Mount the app under which path?" "$BASE_PATH"
BASE_PATH="$(normalize_path "$BASE_PATH")"
[ -n "$BASE_PATH" ] || die "A sub-path is required so other apps can share this server (e.g. /VoiceMa)."
printf '%s' "$BASE_PATH" | grep -Eq '^/[A-Za-z0-9._~-]+$' \
  || die "Use a single path segment of letters, digits, dot, dash or underscore — for example /VoiceMa"

while port_in_use "$APP_PORT"; do
  warn "Port ${APP_PORT} is already in use."
  APP_PORT=$((APP_PORT + 1))
done
ask APP_PORT    "Internal port for the app (localhost only)?" "$APP_PORT"
port_in_use "$APP_PORT" && die "Port ${APP_PORT} is in use. Pick another with --port."

ask SERVER_NAME "Display name shown in the app?" "$SERVER_NAME"
ask CERT_HOSTS  "Address people will type (IP or hostname)?" "$DETECTED_IP"
[ -n "$SERVER_PASSWORD" ] || ask_secret SERVER_PASSWORD "Optional password to enter the server:"

APP_URL="https://${CERT_HOSTS}${BASE_PATH}/"

printf '\n'
info "${BOLD}Plan${RESET}"
info "  URL             ${BLUE}${APP_URL}${RESET}"
info "  App directory   ${APP_DIR}"
info "  Runs as         ${SERVICE_USER} (systemd service '${APP_NAME}')"
info "  Internal        http://127.0.0.1:${APP_PORT}  (not reachable from the network)"
info "  Front door      nginx on :443, TLS from a generated local CA"
info "  Server password $([ -n "$SERVER_PASSWORD" ] && echo 'set' || echo 'none')"
printf '\n'
confirm "Proceed?" || { printf '    Cancelled.\n\n'; exit 0; }

# ----------------------------------------------------------------------------
# Packages
# ----------------------------------------------------------------------------

step "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl git gnupg openssl nginx iproute2 >/dev/null
ok "curl, git, openssl, nginx"

# Node.js: use the system one when it is new enough, otherwise NodeSource.
NODE_OK=0
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
  if [ "$NODE_MAJOR" -ge "$NODE_MAJOR_MIN" ] 2>/dev/null; then
    NODE_OK=1
    ok "Node.js $(node -v) already present"
  else
    warn "Node.js $(node -v) is too old (need ${NODE_MAJOR_MIN}+)"
  fi
fi

if [ "$NODE_OK" = "0" ]; then
  info "Adding the NodeSource repository for Node.js ${NODE_MAJOR_INSTALL}.x"
  install -d -m 0755 /usr/share/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor --yes -o /usr/share/keyrings/nodesource.gpg
  chmod 0644 /usr/share/keyrings/nodesource.gpg
  echo "deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR_INSTALL}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs >/dev/null
  ok "Node.js $(node -v)"
fi

# ----------------------------------------------------------------------------
# Application
# ----------------------------------------------------------------------------

step "Installing the application"

if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
  ok "Created service user '${SERVICE_USER}'"
else
  ok "Service user '${SERVICE_USER}' already exists"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -d "${APP_DIR}/.git" ]; then
  info "Updating the existing checkout"
  git -C "$APP_DIR" remote set-url origin "$REPO_URL"
  git -C "$APP_DIR" fetch --depth 1 origin HEAD
  git -C "$APP_DIR" reset --hard FETCH_HEAD
  ok "Updated to $(git -C "$APP_DIR" rev-parse --short HEAD)"
elif [ -f "${SCRIPT_DIR}/server/index.js" ] && [ "$SCRIPT_DIR" != "$APP_DIR" ]; then
  # Running from a copy of the source that is not the install target.
  info "Copying from ${SCRIPT_DIR}"
  mkdir -p "$APP_DIR"
  tar -C "$SCRIPT_DIR" --exclude=node_modules --exclude=.git -cf - . | tar -C "$APP_DIR" -xf -
  ok "Copied into ${APP_DIR}"
elif [ "$SCRIPT_DIR" = "$APP_DIR" ]; then
  # Installed by a plain file copy, so there is no checkout here to pull from.
  # Without this branch the documented update command ("run install.sh again")
  # silently did nothing: it re-wrote the unit and nginx config around exactly
  # the same stale source. Fetch a fresh snapshot and lay it over the top.
  info "Refreshing ${APP_DIR} from ${REPO_URL}"
  TMP_SRC="$(mktemp -d)"
  if git clone --depth 1 "$REPO_URL" "${TMP_SRC}/src" >/dev/null 2>&1; then
    # certs/, data/ and config.json are machine state, not source — never
    # clobber them. install.sh is held back because this very script is being
    # read from disk as it runs; it is swapped in by rename at the end, which
    # leaves the running inode intact.
    tar -C "${TMP_SRC}/src" --exclude=node_modules --exclude=.git         --exclude=./certs --exclude=./data --exclude=./config.json         --exclude=./install.sh -cf - . | tar -C "$APP_DIR" -xf -
    if [ -f "${TMP_SRC}/src/install.sh" ]; then
      cp "${TMP_SRC}/src/install.sh" "${APP_DIR}/.install.sh.new"
      chmod +x "${APP_DIR}/.install.sh.new"
      mv -f "${APP_DIR}/.install.sh.new" "${APP_DIR}/install.sh"
    fi
    ok "Updated to $(git -C "${TMP_SRC}/src" rev-parse --short HEAD)"
  else
    warn "Could not reach ${REPO_URL} — keeping the files already in ${APP_DIR}"
  fi
  rm -rf "$TMP_SRC"
else
  info "Cloning ${REPO_URL}"
  git clone --depth 1 "$REPO_URL" "$APP_DIR"
  ok "Cloned to ${APP_DIR}"
fi

cd "$APP_DIR"

info "Installing dependencies"
if [ -f package-lock.json ]; then
  npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1 \
    || npm install --omit=dev --no-audit --no-fund >/dev/null
else
  npm install --omit=dev --no-audit --no-fund >/dev/null
fi
ok "Dependencies installed"

info "Generating icons"
node scripts/gen-icons.js --if-missing >/dev/null
ok "Icon set ready"

# ----------------------------------------------------------------------------
# Certificate
# ----------------------------------------------------------------------------

step "TLS certificate"

if [ -f "${APP_DIR}/certs/server.crt" ] && [ -f "${APP_DIR}/certs/ca.crt" ]; then
  ok "Reusing the existing certificate (delete ${APP_DIR}/certs to regenerate)"
else
  info "Generating a local CA and a server certificate"
  VOICEMA_HOSTS="$CERT_HOSTS" node scripts/gen-cert.js >/dev/null
  ok "Certificate covers this machine's addresses and '${CERT_HOSTS}'"
fi

# The app (as voicema) reads ca.crt to hand out; nginx (as root) reads the key.
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${APP_DIR}/certs"
chmod 0755 "${APP_DIR}/certs"
chmod 0644 "${APP_DIR}/certs/ca.crt" "${APP_DIR}/certs/server.crt"
chmod 0640 "${APP_DIR}/certs/ca.key" "${APP_DIR}/certs/server.key"

# ----------------------------------------------------------------------------
# Configuration
# ----------------------------------------------------------------------------

step "Writing configuration"

# Escape a value for embedding in JSON. Pure bash on purpose: the sed version
# of this needed three levels of quoting and silently produced an empty string,
# which would have wiped out the server password without saying so.
json_escape() {
  local s=${1-}
  s=${s//\\/\\\\}   # backslash first, or it would double-escape the quotes
  s=${s//\"/\\\"}
  s=${s//$'\n'/ }
  s=${s//$'\r'/ }
  s=${s//$'\t'/ }
  printf '%s' "$s"
}

cat > "${APP_DIR}/config.json" <<EOF
{
  "serverName": "$(json_escape "$SERVER_NAME")",
  "httpsPort": ${APP_PORT},
  "httpRedirectPort": 0,
  "bindAddress": "127.0.0.1",
  "basePath": "${BASE_PATH}",
  "password": "$(json_escape "$SERVER_PASSWORD")",
  "maxUsersPerChannel": 12,
  "allowUserChannels": true,
  "channels": [
    { "id": "general", "name": "General", "description": "Everyone lands here" }
  ]
}
EOF
ok "config.json"

mkdir -p "${APP_DIR}/data"
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${APP_DIR}/data"
ok "Data directory"

# ----------------------------------------------------------------------------
# systemd
# ----------------------------------------------------------------------------

step "Creating the service"

cat > "/etc/systemd/system/${APP_NAME}.service" <<EOF
[Unit]
Description=VoiceMa — self-hosted LAN voice chat
Documentation=${REPO_URL}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
# TLS is terminated by nginx, so the app speaks plain HTTP on loopback only.
Environment=VOICEMA_HTTP_ONLY=1
Environment=VOICEMA_PORT=${APP_PORT}
Environment=VOICEMA_BIND=127.0.0.1
Environment=VOICEMA_BASE_PATH=${BASE_PATH}
ExecStart=/usr/bin/node ${APP_DIR}/server/index.js
Restart=always
RestartSec=3

# Hardening: the service only ever needs to write its own data directory.
NoNewPrivileges=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
# AF_NETLINK is required: Node uses it to enumerate network interfaces, and
# without it os.networkInterfaces() throws EAFNOSUPPORT at startup.
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
ReadWritePaths=${APP_DIR}/data

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$APP_NAME" >/dev/null 2>&1
systemctl restart "$APP_NAME"
ok "Service '${APP_NAME}' enabled and started"

# Give it a moment, then confirm it is actually serving.
sleep 2
if ! systemctl is-active --quiet "$APP_NAME"; then
  journalctl -u "$APP_NAME" -n 30 --no-pager >&2 || true
  die "The service failed to start. The last log lines are above."
fi
if ! curl -fsS "http://127.0.0.1:${APP_PORT}${BASE_PATH}/health" >/dev/null 2>&1; then
  journalctl -u "$APP_NAME" -n 30 --no-pager >&2 || true
  die "The app is running but not answering on http://127.0.0.1:${APP_PORT}${BASE_PATH}/health"
fi
ok "Health check passed"

# ----------------------------------------------------------------------------
# nginx
# ----------------------------------------------------------------------------

step "Configuring nginx"

mkdir -p "$NGINX_APPS_DIR"

# HTTP/2 syntax changed in nginx 1.25.1: before that it is a listen-flag,
# after that a standalone directive. Ubuntu 22.04 ships 1.18, so this matters.
NGINX_VERSION="$(nginx -v 2>&1 | sed 's|.*/||; s/[^0-9.].*//')"
if [ -n "$NGINX_VERSION" ] && \
   [ "$(printf '%s\n1.25.1\n' "$NGINX_VERSION" | sort -V | head -n1)" = "1.25.1" ]; then
  LISTEN_SSL="listen 443 ssl default_server;
    listen [::]:443 ssl default_server;
    http2 on;"
  info "nginx ${NGINX_VERSION} — using the modern 'http2 on;' directive"
else
  LISTEN_SSL="listen 443 ssl http2 default_server;
    listen [::]:443 ssl http2 default_server;"
  info "nginx ${NGINX_VERSION:-<1.25} — using the listen-flag form of http2"
fi

# WebSocket upgrade mapping belongs in the http context, once for the machine.
if [ ! -f /etc/nginx/conf.d/websocket-upgrade.conf ]; then
  cat > /etc/nginx/conf.d/websocket-upgrade.conf <<'EOF'
# Lets any proxied location pass a WebSocket upgrade through cleanly.
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
EOF
  ok "WebSocket upgrade map"
fi

# One shared server block for the whole machine. Other apps drop their own
# location file into /etc/nginx/lan-apps.d/ and reload — this file is written
# once and then left alone.
if [ ! -f "$NGINX_SITE" ]; then
  cat > "$NGINX_SITE" <<EOF
# Shared front door for the applications hosted on this machine.
# Add another app by creating ${NGINX_APPS_DIR}/<app>.conf with its own
# location block, then:  sudo nginx -t && sudo systemctl reload nginx

server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    return 301 https://\$host\$request_uri;
}

server {
    ${LISTEN_SSL}
    server_name _;

    ssl_certificate     ${APP_DIR}/certs/server.crt;
    ssl_certificate_key ${APP_DIR}/certs/server.key;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_session_cache   shared:SSL:10m;
    ssl_session_timeout 1d;

    # Sensible for a LAN: never cut a long-lived socket short.
    proxy_read_timeout  3600s;
    proxy_send_timeout  3600s;
    client_max_body_size 16m;

    location = / {
        default_type text/html;
        return 200 '<!doctype html><meta charset=utf-8><title>Apps</title><h1>Applications</h1><ul><li><a href="${BASE_PATH}/">VoiceMa</a></li></ul>';
    }

    include ${NGINX_APPS_DIR}/*.conf;
}
EOF
  ok "Shared server block at ${NGINX_SITE}"
else
  ok "Shared server block already exists — left untouched"
fi

# This app's location block. Safe to rewrite on every run.
cat > "${NGINX_APPS_DIR}/${APP_NAME}.conf" <<EOF
# VoiceMa — mounted at ${BASE_PATH}
# proxy_pass has no URI part on purpose: the original path (including
# ${BASE_PATH}) is forwarded unchanged, and the app strips its own prefix.

location = ${BASE_PATH} {
    return 301 ${BASE_PATH}/;
}

location ${BASE_PATH}/ {
    proxy_pass http://127.0.0.1:${APP_PORT};
    proxy_http_version 1.1;

    # WebSocket signalling.
    proxy_set_header Upgrade    \$http_upgrade;
    proxy_set_header Connection \$connection_upgrade;

    proxy_set_header Host              \$host;
    proxy_set_header X-Real-IP         \$remote_addr;
    proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;

    # Voice signalling is chatty and latency-sensitive; do not sit on it.
    proxy_buffering off;
    proxy_cache off;
}
EOF
ok "Location block at ${NGINX_APPS_DIR}/${APP_NAME}.conf"

ln -sfn "$NGINX_SITE" "$NGINX_LINK"

# The stock default site also claims default_server on :80 and would clash.
if [ -e /etc/nginx/sites-enabled/default ]; then
  rm -f /etc/nginx/sites-enabled/default
  warn "Disabled the stock nginx default site (it conflicts with default_server)"
fi

if ! nginx -t >/dev/null 2>&1; then
  nginx -t || true
  die "nginx rejected the configuration — see the output above."
fi
systemctl enable nginx >/dev/null 2>&1 || true
systemctl reload nginx 2>/dev/null || systemctl restart nginx
ok "nginx reloaded"

# ----------------------------------------------------------------------------
# Firewall
# ----------------------------------------------------------------------------

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
  step "Firewall"
  ufw allow 80/tcp  >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
  ok "Opened 80/tcp and 443/tcp in ufw"
fi

# ----------------------------------------------------------------------------
# Verify through the front door
# ----------------------------------------------------------------------------

step "Verifying"

if curl -fsSk "https://127.0.0.1${BASE_PATH}/health" >/dev/null 2>&1; then
  ok "Reachable through nginx over HTTPS"
else
  warn "Could not reach https://127.0.0.1${BASE_PATH}/health — check: nginx -t, journalctl -u ${APP_NAME}"
fi

if curl -fsSk "https://127.0.0.1${BASE_PATH}/api/info" 2>/dev/null | grep -q '"name"'; then
  ok "API responding"
fi

# ----------------------------------------------------------------------------
# Done
# ----------------------------------------------------------------------------

printf '\n%s' "$MAGENTA"
printf '──────────────────────────────────────────────────────────\n'
printf '%s' "$RESET"
printf '  %sVoiceMa is installed and running.%s\n\n' "$BOLD" "$RESET"
printf '  Open        %s%s%s\n' "$BLUE" "$APP_URL" "$RESET"
printf '  Certificate %s%sca.crt%s   %s(install this on every device)%s\n' \
       "$BLUE" "$APP_URL" "$RESET" "$DIM" "$RESET"
printf '\n'
printf '  %sFirst visit will warn about the certificate.%s That is expected until\n' "$YELLOW" "$RESET"
printf '  you install the CA above — see DEPLOY.md for the per-device steps.\n'
printf '  Until it is trusted, phones cannot install the app to the home screen.\n'
printf '\n'
printf '  Service     systemctl status %s\n' "$APP_NAME"
printf '  Logs        journalctl -u %s -f\n' "$APP_NAME"
printf '  Restart     systemctl restart %s\n' "$APP_NAME"
printf '  Update      sudo bash %s/install.sh --yes\n' "$APP_DIR"
printf '\n'
printf '  Add another app alongside this one:\n'
printf '    create %s/<app>.conf with its own location block,\n' "$NGINX_APPS_DIR"
printf '    then   sudo nginx -t && sudo systemctl reload nginx\n'
printf '%s' "$MAGENTA"
printf '──────────────────────────────────────────────────────────\n'
printf '%s\n' "$RESET"
