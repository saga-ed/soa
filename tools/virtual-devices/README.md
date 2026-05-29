# vdev — virtual cameras & mics

OS-level synthetic capture devices for testing conferencing/recording flows
without real hardware. Unlike Chrome's `--use-file-for-fake-video-capture` flag
(browser-only, single static file) or the LiveKit SDK publisher (in-memory, no
device node), these are **real V4L2 + PulseAudio devices**: any app — a browser
conferencing client, OBS, ffmpeg — sees them in its device picker, you can run
several at once, and each plays a looping, moving synthetic clip.

Each "device" N is a pair:

| | name | node |
|---|---|---|
| camera | `Virtual Cam N` | `/dev/video$((10 + N - 1))` |
| mic | `Virtual Mic N` | pulse source `vmicN` |

## Requirements

Linux with `ffmpeg`, `v4l-utils`, the `v4l2loopback` kernel module, and
PipeWire/PulseAudio (`pactl`). On Ubuntu: `apt install ffmpeg v4l-utils
v4l2loopback-dkms`. The **only** privileged operation is loading the kernel
module (`sudo modprobe v4l2loopback`), which `vdev up`/`vdev down` invoke for
you; everything else runs as your user. Pass `--skip-modprobe` if the module is
already loaded (e.g. persisted at boot) to run `vdev up` without sudo. Note that
`vdev down` always tries to unload the module (`sudo modprobe -r`) and will
prompt for sudo — so on a boot-persisted setup, `vdev down` will actually unload
the module (defeating the persistence until the next boot). If you only want to
stop the feeders without unloading, kill the ffmpeg feeders yourself instead of
running `vdev down`.

## Usage

```bash
cd tools/virtual-devices

./vdev up              # 2 cams + 2 mics (auto-generates clips on first run)
./vdev up --count 4    # 4 of each
./vdev up --cams 3 --no-audio
./vdev status          # what's running
./vdev attach cam1 ~/clips/demo.mp4   # swap one camera's source (loops the file)
./vdev attach mic2 ~/audio/voice.wav
./vdev down            # stop feeders, remove mics, unload module
```

Pin specific clips per device with a config file:

```bash
cp devices.conf.example devices.conf   # edit paths
./vdev up --config devices.conf
```

### Verify it in a browser

```bash
python3 -m http.server 8099            # from this directory
# open http://localhost:8099/webcam-test.html, pick "Virtual Cam 1" / "Virtual Mic 1"
```

The picker should list the virtual devices; selecting one shows the looping clip
and the audio meter moves with the synthetic tone.

## Synthetic media

`./vdev gen` (run automatically by `up` when clips are missing) writes one clip
per slot to `assets/`:

- **video** `cam{N}.mp4` — a distinct base pattern (testsrc2 / smptebars /
  rgbtestsrc / mandelbrot) overlaid with a `CAM N` label, a running clock, and a
  frame counter, so feeds are clearly **non-static** and easy to tell apart.
- **audio** `mic{N}.wav` — a distinct per-mic tone, pulsed so it's audible.

Regenerate or resize:

```bash
./vdev gen --count 4 --force
VDEV_WIDTH=640 VDEV_HEIGHT=480 VDEV_FPS=15 ./vdev gen --force
```

`assets/` is git-ignored — clips are regenerable, never committed.

## Tuning (env vars)

| var | default | meaning |
|---|---|---|
| `VDEV_VIDEO_NR_BASE` | `10` | first `/dev/videoN` (avoids real `/dev/video0,1`) |
| `VDEV_WIDTH`/`VDEV_HEIGHT`/`VDEV_FPS` | `1280`/`720`/`30` | camera caps |
| `VDEV_PIXFMT` | `yuv420p` | set to `yuyv422` if an app rejects the format |
| `VDEV_AUDIO_RATE` | `48000` | virtual-mic sample rate (Hz) |
| `VDEV_CLIP_SECONDS` | `60` | generated clip length (looped at playback) |
| `VDEV_COUNT_DEFAULT` | `2` | devices when `--count` omitted |
| `VDEV_FEEDER_SETTLE` | `0.4` | seconds `up` waits to confirm a feeder stayed alive |

State (PIDs, logs, pulse module ids) lives in `~/.local/state/vdev/`
(`$XDG_STATE_HOME/vdev`); override with `VDEV_STATE`. Clips default to `assets/`;
override the directory with `VDEV_ASSETS`.

## Troubleshooting

- **Camera missing from a browser picker** — the `exclusive_caps=1` modprobe
  option (set by `vdev up`) is what makes Chrome/Firefox treat the device as
  capture-only; confirm with `v4l2-ctl --list-devices`.
- **`vdev down` says "device busy"** — a reader (browser tab, OBS) still holds the
  device. Close it and re-run `vdev down`.
- **`vdev status` shows `feeder: dead`** — the ffmpeg feeder for that device
  exited (often because a reader closed the loopback). Check its log under
  `~/.local/state/vdev/logs/cam{N}.log` (or `mic{N}.log`) and re-run `vdev up`.
- **Mic shows as "Monitor of …"** — `vdev` uses `module-remap-source` to expose a
  clean `Virtual Mic N` capture source; if your app only lists monitors, select
  `vmicN` / "Virtual Mic N" explicitly.
- **No text on the video** — install a TTF font (e.g. `fonts-dejavu-core`); motion
  still works without it.
- **Persist across reboots (optional)** — drop a `/etc/modules-load.d/` +
  `/etc/modprobe.d/` config for `v4l2loopback` so the devices come up at boot.
  Not done by default to keep the tool side-effect-free.
