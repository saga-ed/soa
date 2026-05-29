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

# Unload a pactl module by id and report success if it's gone afterward —
# treats an already-absent (stale) id as success rather than a failure.
audio_unload_gone() {
  local id="$1"
  pactl unload-module "$id" 2>/dev/null || true
  ! pactl list short modules 2>/dev/null | awk '{print $1}' | grep -qx "$id"
}

# audio_create_mic INDEX
# Returns non-zero (without exiting) on failure so callers can aggregate.
audio_create_mic() {
  local idx="$1" sink_id src_id
  local sink_name="vmic${idx}_sink" src_name="vmic${idx}"

  # Tear down a stale instance with the same name first (idempotent).
  audio_destroy_mic "$idx" >/dev/null 2>&1 || true

  sink_id="$(pactl load-module module-null-sink \
    sink_name="$sink_name" \
    "sink_properties=device.description='Virtual Mic ${idx} sink'")" \
    || { err "mic$idx: failed to create null sink"; return 1; }

  src_id="$(pactl load-module module-remap-source \
    master="${sink_name}.monitor" \
    source_name="$src_name" \
    "source_properties=device.description='Virtual Mic ${idx}'")" \
    || { pactl unload-module "$sink_id" 2>/dev/null || true
         err "mic$idx: failed to create remap source"; return 1; }

  ensure_state_dirs
  # replace any existing line for this mic
  local tmp; tmp="$(mktemp)"
  grep -v "^mic${idx} " "$VDEV_PULSE_MODULES" 2>/dev/null > "$tmp" || true
  echo "mic${idx} ${sink_id} ${src_id}" >> "$tmp"
  mv "$tmp" "$VDEV_PULSE_MODULES"
  log "mic$idx created: source '$src_name' (sink module $sink_id, source module $src_id)"
}

# audio_destroy_mic INDEX
# Returns non-zero if a module could not be unloaded; in that case the tracking
# line is kept so a later teardown can retry instead of orphaning the sink.
audio_destroy_mic() {
  local idx="$1" line sink_id src_id rc=0
  [[ -f "$VDEV_PULSE_MODULES" ]] || return 0
  line="$(grep "^mic${idx} " "$VDEV_PULSE_MODULES" 2>/dev/null | tail -1)" || return 0
  [[ -n "$line" ]] || return 0
  read -r _ sink_id src_id <<<"$line"
  # remap-source first, then the null-sink it depends on.
  if [[ -n "$src_id" ]] && ! audio_unload_gone "$src_id"; then
    warn "mic$idx: could not unload remap-source module $src_id"; rc=1
  fi
  if [[ -n "$sink_id" ]] && ! audio_unload_gone "$sink_id"; then
    warn "mic$idx: could not unload null-sink module $sink_id"; rc=1
  fi
  if [[ $rc -eq 0 ]]; then
    local tmp; tmp="$(mktemp)"
    grep -v "^mic${idx} " "$VDEV_PULSE_MODULES" 2>/dev/null > "$tmp" || true
    mv "$tmp" "$VDEV_PULSE_MODULES"
  fi
  return $rc
}

# Returns non-zero if any mic could not be fully removed.
audio_destroy_all() {
  [[ -f "$VDEV_PULSE_MODULES" ]] || return 0
  local idx rc=0 indices=()
  # snapshot indices first; audio_destroy_mic rewrites the file as it goes
  while read -r tag _; do
    [[ "$tag" == mic* ]] || continue
    indices+=("${tag#mic}")
  done < "$VDEV_PULSE_MODULES"
  for idx in "${indices[@]}"; do
    audio_destroy_mic "$idx" || rc=1
  done
  return $rc
}

# audio_start_feeder INDEX AUDIOFILE
# Returns non-zero (without exiting) if the feeder can't be started or dies
# immediately, so callers can aggregate per-device failures.
audio_start_feeder() {
  local idx="$1" audio="$2"
  local sink="vmic${idx}_sink" pidf logf pid
  pidf="$VDEV_PIDS/mic${idx}.pid"
  logf="$VDEV_LOGS/mic${idx}.log"
  require_cmd ffmpeg
  [[ -f "$audio" ]] || { err "mic$idx: audio not found: $audio"; return 1; }

  # ffmpeg keeps running even if -device names a sink that doesn't exist, so a
  # feeder pointed at a missing sink would survive the liveness check and falsely
  # report "playing". Require the sink up front (e.g. `attach` before `up`).
  if ! pactl list short sinks 2>/dev/null | awk '{print $2}' | grep -qx "$sink"; then
    err "mic$idx: pulse sink '$sink' not found — create the mic first (run 'vdev up')"
    return 1
  fi

  audio_stop_feeder "$idx"

  log "mic$idx <- $audio  (sink $sink)"
  nohup ffmpeg -hide_banner -loglevel warning -nostdin \
    -re -stream_loop -1 -i "$audio" \
    -ac 1 -ar "$VDEV_AUDIO_RATE" \
    -f pulse -device "$sink" "vmic${idx}-feed" \
    >"$logf" 2>&1 &
  pid=$!
  if ! echo "$pid" > "$pidf"; then
    kill "$pid" 2>/dev/null || true
    err "mic$idx: could not record pid (state dir $VDEV_PIDS not writable?)"
    return 1
  fi

  # The source exists as soon as the modules load, so a dead feeder would look
  # healthy. We can't cheaply confirm audio is truly flowing, so settle briefly
  # and require the ffmpeg process to still be alive before claiming the mic is up.
  sleep "$VDEV_FEEDER_SETTLE"
  if ! pid_is_feeder "$pid"; then
    rm -f "$pidf"
    err "mic$idx feeder died immediately (audio=$audio sink=$sink) — last log lines:"
    tail -n 12 "$logf" >&2 || true
    return 1
  fi
  # Feeder is up; don't let a metadata-write failure flip that verdict (see video.sh).
  meta_set "mic${idx}_audio" "$audio" || warn "mic$idx: feeder up but could not record audio metadata"
  return 0
}

# Mic feeder lifecycle — thin wrappers over the shared helpers in common.sh.
audio_stop_feeder()  { feeder_stop mic "$1"; }
audio_stop_all()     { feeder_stop_all mic; }
audio_feeder_state() { feeder_state mic "$1"; }
