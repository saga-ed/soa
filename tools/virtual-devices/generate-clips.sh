#!/usr/bin/env bash
# Generate the default synthetic clip library: one distinct, MOVING, labeled
# video clip per camera plus one distinct-tone audio clip per mic.
#
# Usage: generate-clips.sh [--count N] [--out DIR] [--force]
# Also callable via `vdev gen`.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SELF_DIR/lib/common.sh"

COUNT="$VDEV_COUNT_DEFAULT"
OUT="$VDEV_ASSETS"
FORCE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --count) COUNT="$2"; shift 2;;
    --out)   OUT="$2"; shift 2;;
    --force) FORCE=1; shift;;
    -h|--help) awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "$0"; exit 0;;
    *) die "unknown arg: $1";;
  esac
done

require_cmd ffmpeg
mkdir -p "$OUT"

# A bold font for the on-screen labels; motion comes from the live clock +
# frame counter overlays, so a missing font only drops the text, not the motion.
find_font() {
  local f
  for f in \
    /usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf \
    /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf \
    /usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf \
    /usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf; do
    [[ -f "$f" ]] && { echo "$f"; return 0; }
  done
  return 1
}
FONT="$(find_font || true)"
[[ -n "$FONT" ]] || warn "no TTF font found; clips will have motion but no text labels"

# Visually distinct base patterns, cycled per camera.
SOURCES=(testsrc2 smptebars rgbtestsrc mandelbrot)

gen_video() {
  local idx="$1" out="$2"
  local src="${SOURCES[$(( (idx - 1) % ${#SOURCES[@]} ))]}"
  local vf="format=${VDEV_PIXFMT}"
  if [[ -n "$FONT" ]]; then
    local label
    vf="drawtext=fontfile=${FONT}:text='CAM ${idx}':fontcolor=white:fontsize=110:box=1:boxcolor=black@0.55:boxborderw=16:x=40:y=40"
    vf+=",drawtext=fontfile=${FONT}:text='%{pts\\:hms}':fontcolor=yellow:fontsize=72:box=1:boxcolor=black@0.55:boxborderw=10:x=40:y=h-120"
    vf+=",drawtext=fontfile=${FONT}:text='frame %{n}':fontcolor=cyan:fontsize=44:box=1:boxcolor=black@0.45:boxborderw=8:x=40:y=h-220"
    vf+=",format=${VDEV_PIXFMT}"
  fi
  log "generating $out  (source=$src, ${VDEV_WIDTH}x${VDEV_HEIGHT}@${VDEV_FPS}, ${VDEV_CLIP_SECONDS}s)"
  ffmpeg -y -hide_banner -loglevel error \
    -f lavfi -t "$VDEV_CLIP_SECONDS" -i "${src}=size=${VDEV_WIDTH}x${VDEV_HEIGHT}:rate=${VDEV_FPS}" \
    -vf "$vf" \
    -c:v libx264 -preset veryfast -pix_fmt "$VDEV_PIXFMT" \
    "$out"
}

gen_audio() {
  local idx="$1" out="$2"
  # Distinct, identifiable per-mic tone with a 1 Hz pulse so it's clearly audible.
  local freq=$(( 220 + idx * 110 ))
  log "generating $out  (tone ${freq}Hz, ${VDEV_CLIP_SECONDS}s)"
  ffmpeg -y -hide_banner -loglevel error \
    -f lavfi -t "$VDEV_CLIP_SECONDS" \
    -i "sine=frequency=${freq}:sample_rate=${VDEV_AUDIO_RATE}" \
    -af "tremolo=f=2:d=0.8,volume=0.5" \
    -ac 1 -ar "$VDEV_AUDIO_RATE" \
    "$out"
}

for ((i = 1; i <= COUNT; i++)); do
  v="$OUT/cam${i}.mp4"
  a="$OUT/mic${i}.wav"
  if [[ -f "$v" && $FORCE -eq 0 ]]; then dim "skip $v (exists; --force to regenerate)"; else gen_video "$i" "$v"; fi
  if [[ -f "$a" && $FORCE -eq 0 ]]; then dim "skip $a (exists; --force to regenerate)"; else gen_audio "$i" "$a"; fi
done

ok "clip library ready in $OUT ($COUNT camera(s) + $COUNT mic(s))"
