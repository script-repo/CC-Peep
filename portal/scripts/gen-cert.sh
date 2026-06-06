#!/usr/bin/env bash
# Generate a self-signed TLS cert for the portal so browsers get a secure context
# (required for microphone capture). Output: portal/certs/{cert.pem,key.pem}.
#
#   bash portal/scripts/gen-cert.sh [host-or-ip]
#
# The host/IP becomes the certificate's Subject Alternative Name. Defaults to this
# machine's primary IP.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CERT_DIR="$(cd "$HERE/.." && pwd)/certs"
HOST="${1:-$(hostname -I 2>/dev/null | awk '{print $1}')}"
HOST="${HOST:-localhost}"
DAYS="${CCPEEP_TLS_DAYS:-825}"

if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl is required. Install it (e.g. sudo dnf install -y openssl) and re-run." >&2
  exit 1
fi

mkdir -p "$CERT_DIR"

# SAN supports both an IP and a DNS entry; pick the right type for the given host.
if [[ "$HOST" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  SAN="IP:$HOST"
else
  SAN="DNS:$HOST"
fi

echo "==> Generating self-signed cert for $HOST (SAN=$SAN, ${DAYS}d) in $CERT_DIR"
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$CERT_DIR/key.pem" \
  -out "$CERT_DIR/cert.pem" \
  -days "$DAYS" \
  -subj "/CN=$HOST" \
  -addext "subjectAltName=$SAN" >/dev/null 2>&1

chmod 600 "$CERT_DIR/key.pem"
echo "    Wrote $CERT_DIR/cert.pem and key.pem"
echo "    Start the portal and it will auto-detect these and serve HTTPS/WSS."
