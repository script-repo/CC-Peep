#!/usr/bin/env bash
# Create virtual audio devices on a (possibly headless) Linux box so the CC-Peep audio
# bridge has endpoints to use. Works with PulseAudio or PipeWire's pulse shim (pactl).
#
# It creates two null sinks and a virtual microphone:
#   ccpeep_out         apps play here  -> capture ccpeep_out.monitor for audio.out
#   ccpeep_in          bridge plays browser mic here (audio.in)
#   ccpeep_mic         a SOURCE (virtual mic) fed by ccpeep_in -> apps use it as input
#
# Usage:
#   ./setup-linux-audio.sh            # load the virtual devices
#   ./setup-linux-audio.sh --unload   # remove them
#
# Then run the bridge:
#   node client/audio-linux/audio-bridge.mjs --portal wss://HOST:8080/ws --session lab \
#        --capture-source ccpeep_out.monitor --playback-sink ccpeep_in
# In your Linux app: output -> "CCPeep-Out", microphone -> "CCPeep-Mic".

set -euo pipefail

if ! command -v pactl >/dev/null 2>&1; then
  echo "pactl not found. Install PulseAudio (or PipeWire's pulse shim):" >&2
  echo "  Debian/Ubuntu: sudo apt-get install -y pulseaudio-utils" >&2
  echo "  Fedora/RHEL:   sudo dnf install -y pulseaudio-utils" >&2
  exit 1
fi

unload() {
  # Unload by matching the names we set; ignore if not present.
  pactl list short modules 2>/dev/null | awk '/ccpeep_out|ccpeep_in|ccpeep_mic/ {print $1}' \
    | sort -rn | while read -r id; do pactl unload-module "$id" 2>/dev/null || true; done
  echo "Removed CC-Peep virtual audio devices."
}

if [ "${1:-}" = "--unload" ]; then
  unload
  exit 0
fi

# Idempotent: clear any previous instances first.
unload >/dev/null 2>&1 || true

pactl load-module module-null-sink \
  sink_name=ccpeep_out \
  sink_properties=device.description=CCPeep-Out >/dev/null

pactl load-module module-null-sink \
  sink_name=ccpeep_in \
  sink_properties=device.description=CCPeep-In >/dev/null

# Present ccpeep_in's monitor as a proper capture source (a virtual microphone).
pactl load-module module-remap-source \
  master=ccpeep_in.monitor \
  source_name=ccpeep_mic \
  source_properties=device.description=CCPeep-Mic >/dev/null

echo "CC-Peep virtual audio devices ready:"
echo "  sink   ccpeep_out  (apps OUTPUT here; capture ccpeep_out.monitor)"
echo "  sink   ccpeep_in   (bridge plays browser mic here)"
echo "  source ccpeep_mic  (apps use as MICROPHONE input)"
echo
echo "Run the bridge with:"
echo "  --capture-source ccpeep_out.monitor --playback-sink ccpeep_in"
