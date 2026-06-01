#!/usr/bin/env bash
# Video plane: v4l2loopback module + per-camera ffmpeg feeders.
# Assumes lib/common.sh is already sourced.

# Check /sys/module directly: avoids the `set -o pipefail` + `grep -q` pitfall
# where grep exits early, lsmod gets SIGPIPE, and the pipeline reports failure.
video_module_loaded() { [[ -d /sys/module/v4l2loopback ]]; }

# video_load_module COUNT
# Idempotent: if already loaded with the same device count, reuse it.
# If loaded with a different count, unload and reload (caller must have
# stopped any feeders first, or modprobe -r will fail with "device busy").
video_load_module() {
  local count="$1"
  require_cmd modprobe

  if video_module_loaded; then
    local cur; cur="$(meta_get video_count 2>/dev/null || echo '')"
    if [[ "$cur" == "$count" ]]; then
      log "v4l2loopback already loaded for $count device(s); reusing"
      return 0
    fi
    warn "v4l2loopback loaded for '${cur:-unknown}' device(s); reloading for $count"
    video_unload_module || die "could not unload v4l2loopback (a device is busy?)"
  fi

  local nrs=() labels=() excl=() i nr
  for ((i = 1; i <= count; i++)); do
    nr="$(video_nr_for "$i")"
    nrs+=("$nr")
    labels+=("Virtual Cam $i")
    excl+=("1")
  done
  local nr_csv label_csv excl_csv
  nr_csv="$(IFS=,; echo "${nrs[*]}")"
  label_csv="$(IFS=,; echo "${labels[*]}")"
  excl_csv="$(IFS=,; echo "${excl[*]}")"

  log "loading v4l2loopback (devices=$count video_nr=$nr_csv) — sudo required"
  sudo modprobe v4l2loopback \
    devices="$count" \
    video_nr="$nr_csv" \
    card_label="$label_csv" \
    exclusive_caps="$excl_csv" \
    || die "modprobe v4l2loopback failed"

  meta_set video_count "$count"
  meta_set video_nr_base "$VDEV_VIDEO_NR_BASE"
  ok "v4l2loopback loaded: $count virtual camera(s)"
}

video_unload_module() {
  video_module_loaded || { meta_set video_count 0; return 0; }
  log "unloading v4l2loopback — sudo required"
  sudo modprobe -r v4l2loopback || return 1
  meta_set video_count 0
  return 0
}

# video_start_feeder INDEX CLIP
# Returns non-zero (without exiting) if the feeder can't be started or dies
# immediately, so callers can aggregate per-device failures.
video_start_feeder() {
  local idx="$1" clip="$2"
  local dev pidf logf pid
  dev="$(video_dev_for "$idx")"
  pidf="$VDEV_PIDS/cam${idx}.pid"
  logf="$VDEV_LOGS/cam${idx}.log"
  require_cmd ffmpeg

  [[ -e "$dev" ]] || { err "cam$idx: device $dev does not exist (load the module first)"; return 1; }
  [[ -f "$clip" ]] || { err "cam$idx: clip not found: $clip"; return 1; }

  video_stop_feeder "$idx"  # no-op if not running

  log "cam$idx <- $clip  ($dev)"
  nohup ffmpeg -hide_banner -loglevel warning -nostdin \
    -stream_loop -1 -re -i "$clip" \
    -an -vf "scale=${VDEV_WIDTH}:${VDEV_HEIGHT},fps=${VDEV_FPS},format=${VDEV_PIXFMT}" \
    -f v4l2 "$dev" \
    >"$logf" 2>&1 &
  pid=$!
  if ! echo "$pid" > "$pidf"; then
    kill "$pid" 2>/dev/null || true
    err "cam$idx: could not record pid (state dir $VDEV_PIDS not writable?)"
    return 1
  fi

  # ffmpeg often dies within milliseconds for runtime reasons the pre-flight
  # checks can't catch (pixfmt the device rejects, device already held by a
  # reader, undecodable clip). Settle, then confirm it's still serving before
  # we claim the camera is up.
  sleep "$VDEV_FEEDER_SETTLE"
  if ! pid_is_feeder "$pid"; then
    rm -f "$pidf"
    err "cam$idx feeder died immediately (clip=$clip dev=$dev pixfmt=$VDEV_PIXFMT) — last log lines:"
    tail -n 12 "$logf" >&2 || true
    return 1
  fi
  # The feeder is up; a metadata-write failure must not flip that verdict (which
  # would mark a live feeder "failed" and orphan its ffmpeg). Warn, don't fail.
  meta_set "cam${idx}_clip" "$clip" || warn "cam$idx: feeder up but could not record clip metadata"
  return 0
}

# Camera feeder lifecycle — thin wrappers over the shared helpers in common.sh.
video_stop_feeder()  { feeder_stop cam "$1"; }
video_stop_all()     { feeder_stop_all cam; }
video_feeder_state() { feeder_state cam "$1"; }
