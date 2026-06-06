#!/usr/bin/env bash
# CC-Peep — Linux portal single-line installer.
#
#   curl -fsSL https://raw.githubusercontent.com/script-repo/CC-Peep/main/install.sh | bash
#
# Installs the audio-agents portal (signaling server + web client) on a Linux host:
# ensures Node.js + git, clones the repo, installs dependencies, and starts the portal.
#
# Optional env vars:
#   CCPEEP_PORT   portal HTTP/WS port (default 8080)
#   CCPEEP_DIR    install directory   (default $HOME/CC-Peep)
#   CCPEEP_NO_RUN set to 1 to install without starting the server
#   CCPEEP_TLS    set to 1 to generate a self-signed cert and serve HTTPS/WSS
#                 (browsers require HTTPS to allow microphone capture)

set -euo pipefail

REPO="https://github.com/script-repo/CC-Peep.git"
BRANCH="main"
INSTALL_DIR="${CCPEEP_DIR:-$HOME/CC-Peep}"
PORT="${CCPEEP_PORT:-8080}"

MIN_NODE_MAJOR=18

step() { printf '\033[36m==> %s\033[0m\n' "$1"; }
ok()   { printf '\033[32m    %s\033[0m\n' "$1"; }
warn() { printf '\033[33m    %s\033[0m\n' "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }

# True if a new-enough Node is on PATH.
node_ok() {
  have node || return 1
  local major
  major="$(node --version | sed 's/^v//' | cut -d. -f1)"
  [ "${major:-0}" -ge "$MIN_NODE_MAJOR" ]
}

# RHEL/Rocky/Alma: the old Node 10 comes from the 'nodejs' AppStream module. Switching
# the module stream to a supported one (20, then 18) is conflict-free and needs no
# third-party repo. NodeSource is only a last resort.
install_node_dnf() {
  local pm; pm="$(have dnf && echo dnf || echo yum)"
  for stream in 20 18; do
    step "Switching AppStream nodejs module to :$stream…"
    sudo "$pm" module reset -y nodejs >/dev/null 2>&1 || true
    if sudo "$pm" module install -y "nodejs:$stream/common" --allowerasing; then
      return 0
    fi
  done
  warn "Module streams unavailable; falling back to NodeSource."
  sudo "$pm" remove -y nodejs npm nodejs-full-i18n --allowerasing >/dev/null 2>&1 || true
  sudo "$pm" module reset -y nodejs >/dev/null 2>&1 || true
  sudo "$pm" module disable -y nodejs >/dev/null 2>&1 || true
  curl -fsSL https://rpm.nodesource.com/setup_lts.x | sudo -E bash -
  sudo "$pm" install -y nodejs --allowerasing
}

install_node() {
  step "Installing Node.js LTS (>= $MIN_NODE_MAJOR)…"
  if have apt-get; then
    curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
    sudo apt-get install -y nodejs
  elif have dnf; then
    install_node_dnf
  elif have yum; then
    install_node_dnf
  elif have pacman; then
    sudo pacman -Sy --noconfirm nodejs npm
  else
    echo "Please install Node.js (>= $MIN_NODE_MAJOR) manually, then re-run." >&2
    exit 1
  fi
}

ensure_prereqs() {
  if ! have git; then
    step "Installing git…"
    if   have apt-get; then sudo apt-get update -y && sudo apt-get install -y git
    elif have dnf;     then sudo dnf install -y git
    elif have yum;     then sudo yum install -y git
    elif have pacman;  then sudo pacman -Sy --noconfirm git
    else echo "Please install git manually, then re-run." >&2; exit 1
    fi
  fi
  ok "git: $(git --version)"

  if node_ok; then
    ok "node: $(node --version)"
  else
    if have node; then warn "Node $(node --version) is too old (need >= $MIN_NODE_MAJOR); upgrading…"; fi
    install_node
    if ! node_ok; then
      echo "Node.js is still older than $MIN_NODE_MAJOR after install ($(node --version 2>/dev/null))." >&2
      echo "Remove the distro 'nodejs' package and re-run, or install Node $MIN_NODE_MAJOR+ manually." >&2
      exit 1
    fi
    ok "node: $(node --version)"
  fi
}

get_source() {
  if [ -d "$INSTALL_DIR/.git" ]; then
    step "Updating existing checkout at $INSTALL_DIR…"
    git -C "$INSTALL_DIR" fetch --depth 1 origin "$BRANCH"
    git -C "$INSTALL_DIR" reset --hard "origin/$BRANCH"
  else
    step "Cloning $REPO -> $INSTALL_DIR…"
    rm -rf "$INSTALL_DIR"
    git clone --depth 1 --branch "$BRANCH" "$REPO" "$INSTALL_DIR"
  fi
  ok "Source ready at $INSTALL_DIR"
}

install_portal() {
  step "Installing portal dependencies…"
  ( cd "$INSTALL_DIR/portal/server" && npm install --no-audit --no-fund )
  ok "Dependencies installed"
}

# Generate a self-signed cert when TLS is requested and none exists yet.
maybe_setup_tls() {
  [ "${CCPEEP_TLS:-0}" = "1" ] || return 0
  local certDir="$INSTALL_DIR/portal/certs"
  if [ -f "$certDir/cert.pem" ] && [ -f "$certDir/key.pem" ]; then
    ok "TLS cert already present in $certDir"
    return 0
  fi
  step "Setting up TLS (self-signed cert)…"
  bash "$INSTALL_DIR/portal/scripts/gen-cert.sh" "$HOST_IP"
}

main() {
  printf '\nCC-Peep audio-agents — Linux portal installer\n'
  printf -- '---------------------------------------------\n'
  HOST_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  ensure_prereqs
  get_source
  install_portal
  maybe_setup_tls

  local scheme="http"
  [ "${CCPEEP_TLS:-0}" = "1" ] && scheme="https"

  if [ "${CCPEEP_NO_RUN:-0}" = "1" ]; then
    step "Install complete. Start later with:"
    echo  "    PORT=$PORT node \"$INSTALL_DIR/portal/server/src/index.js\""
    exit 0
  fi

  step "Starting portal on port $PORT (Ctrl+C to stop)…"
  echo  "    Web client: $scheme://$HOST_IP:$PORT/"
  PORT="$PORT" node "$INSTALL_DIR/portal/server/src/index.js"
}

main "$@"
