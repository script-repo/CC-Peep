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

install_node() {
  step "Installing Node.js LTS (>= $MIN_NODE_MAJOR)…"
  if have apt-get; then
    curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
    sudo apt-get install -y nodejs
  elif have dnf; then
    # The distro AppStream 'nodejs' module ships an ancient Node (10) whose nodejs/npm
    # packages conflict with NodeSource's. Remove + disable the module, then install.
    sudo dnf remove -y nodejs npm nodejs-full-i18n >/dev/null 2>&1 || true
    sudo dnf module reset -y nodejs >/dev/null 2>&1 || true
    sudo dnf module disable -y nodejs >/dev/null 2>&1 || true
    curl -fsSL https://rpm.nodesource.com/setup_lts.x | sudo -E bash -
    sudo dnf install -y nodejs
  elif have yum; then
    sudo yum remove -y nodejs npm nodejs-full-i18n >/dev/null 2>&1 || true
    curl -fsSL https://rpm.nodesource.com/setup_lts.x | sudo -E bash -
    sudo yum install -y nodejs
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

main() {
  printf '\nCC-Peep audio-agents — Linux portal installer\n'
  printf -- '---------------------------------------------\n'
  ensure_prereqs
  get_source
  install_portal

  if [ "${CCPEEP_NO_RUN:-0}" = "1" ]; then
    step "Install complete. Start later with:"
    echo  "    PORT=$PORT node \"$INSTALL_DIR/portal/server/src/index.js\""
    exit 0
  fi

  step "Starting portal on port $PORT (Ctrl+C to stop)…"
  echo  "    Web client: http://$(hostname -I 2>/dev/null | awk '{print $1}'):$PORT/"
  PORT="$PORT" node "$INSTALL_DIR/portal/server/src/index.js"
}

main "$@"
