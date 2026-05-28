#!/usr/bin/env bash
# Audio plane: PipeWire/PulseAudio virtual mics (null-sink + remap-source) and
# per-mic ffmpeg feeders. No root required — runs against the user's pulse/pw
# session. Assumes lib/common.sh is already sourced.
#
# Per mic N:
#   - module-null-sink   sink_name=vmicN_sink   (audio played here)
#   - module-remap-source master=vmicN_sink.monitor source_name=vmicN
#     (the selectable "Virtual Mic N" capture device apps see)
# Module ids are tracked in $VDEV_PULSE_MODULES as: "micN <sinkid> <srcid>".

audio_available() { command -v pactl >/dev/null 2>&1 && pactl info >/dev/null 2>&1; }

# audio_create_mic INDEX
audio_create_mic() {
  local idx="$1" sink_id src_id
  local sink_name="vmic${idx}_sink" src_name="vmic${idx}"

  # Tear down a stale instance with the same name first (idempotent).
  audio_destroy_mic "$idx" >/dev/null 2>&1 || true

  sink_id="$(pactl load-module module-null-sink \
    sink_name="$sink_name" \
    "sink_properties=device.description='Virtual Mic ${idx} sink'")" \
    || die "failed to create null sink for mic$idx"

  src_id="$(pactl load-module module-remap-source \
    master="${sink_name}.monitor" \
    source_name="$src_name" \
    "source_properties=device.description='Virtual Mic ${idx}'")" \
    || { pactl unload-module "$sink_id" 2>/dev/null || true
         die "failed to create remap source for mic$idx"; }

  ensure_state_dirs
  # replace any existing line for this mic
  local tmp; tmp="$(mktemp)"
  grep -v "^mic${idx} " "$VDEV_PULSE_MODULES" 2>/dev/null > "$tmp" || true
  echo "mic${idx} ${sink_id} ${src_id}" >> "$tmp"
  mv "$tmp" "$VDEV_PULSE_MODULES"
  log "mic$idx created: source '$src_name' (sink module $sink_id, source module $src_id)"
}

# audio_destroy_mic INDEX
audio_destroy_mic() {
  local idx="$1" line sink_id src_id
  [[ -f "$VDEV_PULSE_MODULES" ]] || return 0
  line="$(grep "^mic${idx} " "$VDEV_PULSE_MODULES" 2>/dev/null | tail -1)" || return 0
  [[ -n "$line" ]] || return 0
  read -r _ sink_id src_id <<<"$line"
  [[ -n "$src_id"  ]] && pactl unload-module "$src_id"  2>/dev/null || true
  [[ -n "$sink_id" ]] && pactl unload-module "$sink_id" 2>/dev/null || true
  local tmp; tmp="$(mktemp)"
  grep -v "^mic${idx} " "$VDEV_PULSE_MODULES" 2>/dev/null > "$tmp" || true
  mv "$tmp" "$VDEV_PULSE_MODULES"
}

audio_destroy_all() {
  [[ -f "$VDEV_PULSE_MODULES" ]] || return 0
  local idx
  # collect indices first; audio_destroy_mic rewrites the file as it goes
  while read -r tag _; do
    [[ "$tag" == mic* ]] || continue
    idx="${tag#mic}"
    audio_destroy_mic "$idx"
  done < <(cat "$VDEV_PULSE_MODULES")
  : > "$VDEV_PULSE_MODULES"
}

# audio_start_feeder INDEX AUDIOFILE
audio_start_feeder() {
  local idx="$1" audio="$2"
  local sink="vmic${idx}_sink" pidf logf
  pidf="$VDEV_PIDS/mic${idx}.pid"
  logf="$VDEV_LOGS/mic${idx}.log"
  require_cmd ffmpeg
  [[ -f "$audio" ]] || die "audio not found for mic$idx: $audio"

  audio_stop_feeder "$idx"

  log "mic$idx <- $audio  (sink $sink)"
  nohup ffmpeg -hide_banner -loglevel warning -nostdin \
    -re -stream_loop -1 -i "$audio" \
    -ac 1 -ar "$VDEV_AUDIO_RATE" \
    -f pulse -device "$sink" "vmic${idx}-feed" \
    >"$logf" 2>&1 &
  echo $! > "$pidf"
  meta_set "mic${idx}_audio" "$audio"
}

audio_stop_feeder() {
  local idx="$1" pid
  local pidf="$VDEV_PIDS/mic${idx}.pid"
  [[ -f "$pidf" ]] || return 0
  pid="$(cat "$pidf" 2>/dev/null || true)"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
  fi
  rm -f "$pidf"
}

audio_stop_all() {
  local pidf idx
  for pidf in "$VDEV_PIDS"/mic*.pid; do
    [[ -e "$pidf" ]] || continue
    idx="$(basename "$pidf" .pid)"; idx="${idx#mic}"
    audio_stop_feeder "$idx"
  done
}

audio_feeder_state() {
  local idx="$1" pid
  local pidf="$VDEV_PIDS/mic${idx}.pid"
  [[ -f "$pidf" ]] || { echo "stopped"; return; }
  pid="$(cat "$pidf" 2>/dev/null || true)"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then echo "alive ($pid)"; else echo "dead"; fi
}
