#!/usr/bin/env bash
# CC-Peep Linux CLIENT one-liner installer (the audio bridge that runs on the machine
# whose audio you want to stream). Self-contained across distros: it installs Node.js
# and ffmpeg (falling back to static/portable builds when the distro has neither),
# fetches the repo, installs deps, optionally loads the ALSA loopback and a systemd
# service, and can start the bridge.
#
#   curl -fsSL https://raw.githubusercontent.com/script-repo/CC-Peep/main/install-client.sh | \
#     CCPEEP_PORTAL=wss://HOST:8080/ws bash
#
# Env:
#   CCPEEP_PORTAL   portal ws(s):// URL (required for run/service)
#   CCPEEP_SESSION  session id (default: lab)
#   CCPEEP_NAME     display name (default: linux-<hostname>)
#   CCPEEP_ALSA=1   load snd-aloop and use hw:Loopback for capture/playback
#   CCPEEP_SERVICE=1  install + start a systemd service (implies a portal URL)
#   CCPEEP_RUN=1    run the bridge in the foreground after install
#   CCPEEP_DIR      install dir (default: $HOME/.cc-peep)
#   CCPEEP_REPO     git URL (default: https://github.com/script-repo/CC-Peep.git)
#   CCPEEP_BRANCH   branch (default: main)

set -euo pipefail

REPO="${CCPEEP_REPO:-https://github.com/script-repo/CC-Peep.git}"
BRANCH="${CCPEEP_BRANCH:-main}"
DIR="${CCPEEP_DIR:-$HOME/.cc-peep}"
SESSION="${CCPEEP_SESSION:-lab}"
NAME="${CCPEEP_NAME:-linux-$(hostname)}"
NODE_MIN=18

step() { printf '\033[36m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m    %s\033[0m\n' "$*"; }
warn() { printf '\033[33m    %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 && SUDO="sudo" || warn "not root and no sudo; package installs may fail"
fi

detect_pkg() {
  for p in apt-get dnf yum zypper pacman apk; do
    command -v "$p" >/dev/null 2>&1 && { echo "$p"; return; }
  done
  echo ""
}
PKG="$(detect_pkg)"

pkg_install() {
  [ -z "$PKG" ] && { warn "no known package manager; skipping '$*'"; return 1; }
  case "$PKG" in
    apt-get) $SUDO apt-get update -y >/dev/null 2>&1 || true; $SUDO apt-get install -y "$@" ;;
    dnf)     $SUDO dnf install -y "$@" ;;
    yum)     $SUDO yum install -y "$@" ;;
    zypper)  $SUDO zypper --non-interactive install "$@" ;;
    pacman)  $SUDO pacman -Sy --noconfirm "$@" ;;
    apk)     $SUDO apk add "$@" ;;
  esac
}

node_major() { command -v node >/dev/null 2>&1 && node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0; }

ensure_node() {
  if [ "$(node_major)" -ge "$NODE_MIN" ] 2>/dev/null; then ok "Node.js $(node -v) present"; return; fi
  step "Installing Node.js (>= $NODE_MIN)..."
  case "$PKG" in
    apt-get)
      curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO -E bash - >/dev/null 2>&1 && pkg_install nodejs || pkg_install nodejs npm ;;
    dnf|yum)
      $SUDO "$PKG" module reset -y nodejs >/dev/null 2>&1 || true
      $SUDO "$PKG" module enable -y nodejs:20 >/dev/null 2>&1 || true
      pkg_install nodejs || { curl -fsSL https://rpm.nodesource.com/setup_20.x | $SUDO -E bash - >/dev/null 2>&1 && pkg_install nodejs; } ;;
    zypper) pkg_install nodejs20 || pkg_install nodejs ;;
    pacman) pkg_install nodejs npm ;;
    apk)    pkg_install nodejs npm ;;
    *)      : ;;
  esac
  if [ "$(node_major)" -lt "$NODE_MIN" ] 2>/dev/null; then
    step "Falling back to a portable Node.js build..."
    local arch tarch nodever
    arch="$(uname -m)"; case "$arch" in x86_64) tarch=x64;; aarch64|arm64) tarch=arm64;; *) die "unsupported arch $arch for portable Node";; esac
    nodever="v20.18.1"
    curl -fsSL "https://nodejs.org/dist/${nodever}/node-${nodever}-linux-${tarch}.tar.xz" -o /tmp/node.tar.xz
    mkdir -p "$DIR/node" && tar -xJf /tmp/node.tar.xz -C "$DIR/node" --strip-components=1
    export PATH="$DIR/node/bin:$PATH"
  fi
  command -v node >/dev/null 2>&1 || die "Node.js install failed"
  ok "Node.js $(node -v)"
}

FFMPEG_BIN="ffmpeg"
ensure_ffmpeg() {
  if command -v ffmpeg >/dev/null 2>&1; then ok "ffmpeg present"; return; fi
  step "Installing ffmpeg..."
  pkg_install ffmpeg >/dev/null 2>&1 || true
  if command -v ffmpeg >/dev/null 2>&1; then ok "ffmpeg installed"; return; fi
  step "Distro has no ffmpeg package; fetching a static build..."
  local arch farch
  arch="$(uname -m)"; case "$arch" in x86_64) farch=amd64;; aarch64|arm64) farch=arm64;; *) die "no static ffmpeg for $arch";; esac
  curl -fsSL "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-${farch}-static.tar.xz" -o /tmp/ffmpeg.tar.xz
  mkdir -p "$DIR/ffmpeg" && tar -xJf /tmp/ffmpeg.tar.xz -C "$DIR/ffmpeg" --strip-components=1
  FFMPEG_BIN="$DIR/ffmpeg/ffmpeg"
  [ -x "$FFMPEG_BIN" ] || die "static ffmpeg extraction failed"
  ok "static ffmpeg -> $FFMPEG_BIN"
}

ensure_repo() {
  if [ -d "$DIR/.git" ]; then
    step "Updating checkout at $DIR..."
    git -C "$DIR" fetch --depth 1 origin "$BRANCH" >/dev/null 2>&1 && git -C "$DIR" reset --hard "origin/$BRANCH" >/dev/null 2>&1 || true
  else
    command -v git >/dev/null 2>&1 || pkg_install git
    step "Cloning $REPO -> $DIR..."
    if command -v git >/dev/null 2>&1; then
      git clone --depth 1 -b "$BRANCH" "$REPO" "$DIR"
    else
      mkdir -p "$DIR"
      curl -fsSL "https://github.com/script-repo/CC-Peep/archive/refs/heads/${BRANCH}.tar.gz" | tar -xz -C "$DIR" --strip-components=1
    fi
  fi
  ok "source at $DIR"
}

setup_alsa() {
  step "Loading ALSA loopback (snd-aloop)..."
  $SUDO modprobe snd-aloop 2>/dev/null && {
    echo snd-aloop | $SUDO tee /etc/modules-load.d/snd-aloop.conf >/dev/null 2>&1 || true
    ok "snd-aloop loaded (persisted)"
  } || warn "could not load snd-aloop (need kernel-modules-extra?); ALSA mode unavailable"
}

main() {
  [ -z "$PKG" ] && warn "no package manager detected; assuming node/ffmpeg/git already present"
  command -v curl >/dev/null 2>&1 || pkg_install curl || die "curl is required"
  ensure_node
  ensure_ffmpeg
  ensure_repo

  step "Installing client dependencies..."
  ( cd "$DIR/client/audio-linux" && npm install --no-audit --no-fund >/dev/null 2>&1 )
  ok "deps installed"

  local capture_args=()
  if [ "${CCPEEP_ALSA:-0}" = "1" ]; then
    setup_alsa
    capture_args=(--capture-format alsa --capture-source hw:Loopback,1,0 --playback-format alsa --playback-sink hw:Loopback,0,1)
  fi

  local run=( node "$DIR/client/audio-linux/audio-bridge.mjs"
              --portal "${CCPEEP_PORTAL:-ws://localhost:8080/ws}" --session "$SESSION" --name "$NAME"
              --ffmpeg "$FFMPEG_BIN" "${capture_args[@]}" )

  if [ "${CCPEEP_SERVICE:-0}" = "1" ]; then
    [ -n "${CCPEEP_PORTAL:-}" ] || die "CCPEEP_SERVICE=1 requires CCPEEP_PORTAL"
    install_service "${run[@]}"
  fi

  echo
  step "Done. Run the bridge with:"
  printf '  CCPEEP_FFMPEG=%q ' "$FFMPEG_BIN"
  printf '%q ' "${run[@]}"; echo
  echo
  if [ "${CCPEEP_RUN:-0}" = "1" ]; then
    [ -n "${CCPEEP_PORTAL:-}" ] || die "CCPEEP_RUN=1 requires CCPEEP_PORTAL"
    step "Starting bridge (Ctrl+C to stop)..."
    exec "${run[@]}"
  fi
}

install_service() {
  local unit=/etc/systemd/system/cc-peep-client.service
  local nodebin; nodebin="$(command -v node)"
  step "Installing systemd service -> $unit"
  $SUDO tee "$unit" >/dev/null <<EOF
[Unit]
Description=CC-Peep Linux audio bridge
After=network-online.target sound.target
Wants=network-online.target

[Service]
Type=simple
Environment=CCPEEP_FFMPEG=$FFMPEG_BIN
ExecStartPre=/sbin/modprobe snd-aloop
ExecStart=$nodebin $DIR/client/audio-linux/audio-bridge.mjs --portal $CCPEEP_PORTAL --session $SESSION --name $NAME --ffmpeg $FFMPEG_BIN ${CCPEEP_ALSA:+--capture-format alsa --capture-source hw:Loopback,1,0 --playback-format alsa --playback-sink hw:Loopback,0,1}
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable --now cc-peep-client.service
  ok "service started: systemctl status cc-peep-client"
}

main "$@"
