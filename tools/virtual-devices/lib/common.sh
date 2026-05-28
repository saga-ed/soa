#!/usr/bin/env bash
# Shared helpers, paths, and defaults for the vdev virtual-device tooling.
# Sourced by vdev, generate-clips.sh, and the lib/*.sh modules.

# Resolve repo-relative paths from this file's location (lib/ -> parent).
VDEV_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VDEV_ROOT="$(dirname "$VDEV_LIB_DIR")"

# Where generated clips live (override with VDEV_ASSETS).
VDEV_ASSETS="${VDEV_ASSETS:-$VDEV_ROOT/assets}"

# Runtime state (PIDs, logs, pulse module ids). XDG state dir; override w/ VDEV_STATE.
VDEV_STATE="${VDEV_STATE:-${XDG_STATE_HOME:-$HOME/.local/state}/vdev}"
VDEV_PIDS="$VDEV_STATE/pids"
VDEV_LOGS="$VDEV_STATE/logs"
VDEV_PULSE_MODULES="$VDEV_STATE/pulse-modules"   # one pactl module id per line
VDEV_META="$VDEV_STATE/meta"                     # key=value runtime facts

# Device defaults (all overridable via env).
VDEV_VIDEO_NR_BASE="${VDEV_VIDEO_NR_BASE:-10}"   # first /dev/videoN for cam 1
VDEV_WIDTH="${VDEV_WIDTH:-1280}"
VDEV_HEIGHT="${VDEV_HEIGHT:-720}"
VDEV_FPS="${VDEV_FPS:-30}"
VDEV_PIXFMT="${VDEV_PIXFMT:-yuv420p}"            # YU12; set to yuyv422 as fallback
VDEV_COUNT_DEFAULT="${VDEV_COUNT_DEFAULT:-2}"
VDEV_CLIP_SECONDS="${VDEV_CLIP_SECONDS:-60}"
VDEV_AUDIO_RATE="${VDEV_AUDIO_RATE:-48000}"

# ---- logging -------------------------------------------------------------
if [[ -t 2 ]]; then
  _c_red=$'\033[31m'; _c_grn=$'\033[32m'; _c_ylw=$'\033[33m'
  _c_blu=$'\033[34m'; _c_dim=$'\033[2m'; _c_rst=$'\033[0m'
else
  _c_red=; _c_grn=; _c_ylw=; _c_blu=; _c_dim=; _c_rst=
fi

log()  { printf '%s[vdev]%s %s\n'      "$_c_blu" "$_c_rst" "$*" >&2; }
ok()   { printf '%s[vdev]%s %s\n'      "$_c_grn" "$_c_rst" "$*" >&2; }
warn() { printf '%s[vdev] warn:%s %s\n' "$_c_ylw" "$_c_rst" "$*" >&2; }
err()  { printf '%s[vdev] error:%s %s\n' "$_c_red" "$_c_rst" "$*" >&2; }
die()  { err "$*"; exit 1; }
dim()  { printf '%s%s%s\n' "$_c_dim" "$*" "$_c_rst" >&2; }

ensure_state_dirs() {
  mkdir -p "$VDEV_PIDS" "$VDEV_LOGS"
  touch "$VDEV_PULSE_MODULES" "$VDEV_META"
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

# Map a 1-based device index to its /dev/video number.
video_nr_for() { echo $(( VDEV_VIDEO_NR_BASE + $1 - 1 )); }
video_dev_for() { echo "/dev/video$(video_nr_for "$1")"; }

# meta_set KEY VALUE / meta_get KEY
meta_set() {
  ensure_state_dirs
  local key="$1" val="$2" tmp
  tmp="$(mktemp)"
  grep -v "^${key}=" "$VDEV_META" 2>/dev/null > "$tmp" || true
  echo "${key}=${val}" >> "$tmp"
  mv "$tmp" "$VDEV_META"
}
meta_get() {
  [[ -f "$VDEV_META" ]] || return 1
  local line
  line="$(grep "^${1}=" "$VDEV_META" 2>/dev/null | tail -1)" || return 1
  [[ -n "$line" ]] || return 1
  echo "${line#*=}"
}
