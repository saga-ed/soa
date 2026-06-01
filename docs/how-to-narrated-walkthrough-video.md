# How to: produce a narrated walkthrough video for a UI feature

A reusable pattern for turning a click-through demo of any saga-soa frontend into a narrated MP4 (or WebM) with synced cursor, voiceover, and SRT subtitles. Built and validated on the SDS dual-mode attendance demo (sds_92, May 2026); generalizable to any Playwright-driveable web UI.

The output is a 2–5 minute video suitable for: exec demos, async PR walkthroughs, onboarding new contributors, attaching to release notes, customer previews. Cost per render: ~$0.15 in OpenAI TTS calls, ~3–5 minutes of wallclock.

---

## When to use this

- A feature is testable end-to-end via Playwright and looks better in motion than in stills.
- You want to share progress with someone who won't run the code themselves.
- You expect the demo to evolve (re-render is cheap; static screen-recordings rot fast).
- The narration matters — you want guided commentary, not just silent footage.

**When NOT to use it:**
- Quick one-off shares (just record yourself with Loom/QuickTime).
- Highly polished marketing assets (use a real video editor + voice talent).
- Anything requiring a face/avatar (use Synthesia/HeyGen).
- The flow needs branching or interactive viewer choices.

---

## Architecture

Four scripts, each runnable independently for cheap iteration:

```
┌────────────┐   ┌────────────┐   ┌────────────┐   ┌────────────┐
│  steps.mjs │──▶│ narrate.mjs│──▶│ record.mjs │──▶│ stitch.mjs │
│  (data)    │   │  (TTS)     │   │ (Playwright)│   │ (ffmpeg)   │
└────────────┘   └────────────┘   └────────────┘   └────────────┘
                       │                  │                │
                       ▼                  ▼                ▼
                 chunks/*.mp3       walkthrough.webm  walkthrough.mp4
                 durations.json     slots.json        walkthrough.srt
```

| Stage | Inputs | Outputs | What it does |
|---|---|---|---|
| `narrate.mjs` | `steps.mjs` (narration text) | `chunks/<id>.mp3`, `durations.json`, `chunks-meta.json` | Sends each step's narration to OpenAI TTS, caches by sha256(model + voice + text). Re-edits to one step's narration only re-synthesize that chunk. |
| `record.mjs` | `steps.mjs` (actions), `durations.json` | `video/walkthrough.webm`, `slots.json` | Playwright drives the UI with a CSS cursor overlay. Per-step slot = `max(actionDuration, narrationDuration) + tailSlack`. Auto-refreshes whatever auth your dev stack uses. |
| `stitch.mjs` | `chunks/*.mp3`, `slots.json`, `walkthrough.webm` | `walkthrough.mp4`, `walkthrough.srt` | Pads each MP3 with trailing silence to match its slot, concats audio, ffmpeg muxes onto the WebM, generates SRT from cumulative slot timestamps. |
| `make.mjs` | (orchestrator) | — | Runs all three. Skip stages with `SKIP_NARRATE=1` / `SKIP_RECORD=1` for cheap iteration. |

The single source of truth is `steps.mjs`, which exports an array of `{id, narration, action(page), tailSlack?}`. Everything else flows from that.

### Sync model

Audio and video stay aligned because each step occupies a known wallclock slot:

```
slot[N] = max(actionDuration[N], narrationDuration[N]) + tailSlack[N]
```

The recorder waits exactly that long before moving on to step N+1; the stitcher pads each narration chunk with trailing silence to fill its slot. Audio chunk N starts at `sum(slot[0..N-1])`, which is also when the recorder began executing step N's action. Synced.

This means: actions can run faster than narration (recorder waits), or longer than narration (recorder extends; padding is silence). What you cannot do is skip ahead in narration if an action is short.

---

## Prerequisites

Per render-machine:

- Node 20+ (for `fetch` + `node:fs/promises`)
- `ffmpeg` + `ffprobe` (Ubuntu: `apt install ffmpeg`)
- A Playwright install reachable from your render scripts. If your monorepo has `@playwright/test` in any workspace's `node_modules`, import from that. Otherwise `pnpm add -D @playwright/test playwright` in the package that holds the scripts.
- `OPENAI_API_KEY` in env. Default model `tts-1-hd`, voice `onyx` — `~$15 / 1M chars`. A 14-step / 3-minute script is ~$0.15.
- Your dev stack running locally (whatever the playwright actions exercise).
- An auth setup the recorder can refresh programmatically. For SOA-style stacks this is typically a `iam.auth.devLogin` POST that sets a session cookie + a sessionStorage payload.

Per repo: nothing special. The scripts are ESM, Node-native, no build step.

---

## Reference implementation

The canonical implementation lives in [saga-dash sds_92](https://github.com/saga-ed/saga-dash/tree/sds_92/scripts/walkthrough-video). Read those scripts side-by-side with this guide — they are short and well-commented:

- `steps.mjs` — declarative beats (narration + action)
- `narrate.mjs` — OpenAI TTS with content-hash caching
- `refresh-session.mjs` — re-mints the dev iam_session cookie
- `record.mjs` — Playwright + cursor overlay + slot timing + auto-refresh
- `stitch.mjs` — ffmpeg pad/concat/mux + SRT
- `make.mjs` — one-shot orchestrator with skip flags

When you set up a new project, copy these eight files (the seven scripts + `.gitignore`) into `<your-repo>/scripts/walkthrough-video/` and adapt as described below.

---

## Setting it up in a new project

### 1. Copy the scripts

```bash
cp -r ~/dev/saga-dash/scripts/walkthrough-video/ <new-repo>/scripts/walkthrough-video/
```

### 2. Adapt `record.mjs` to your auth + dev server

The reference implementation hardcodes the SOA convention: `http://localhost:3000` for iam-api with `dev@example.org` as the dev user, and `http://localhost:8900` for the dash dev server. If your project uses different ports or a different auth flow:

- Change `BASE_URL` and `IAM_ORIGIN` constants (or override via env).
- Replace `refreshDevSession()` with whatever your stack needs. The contract: it must populate `STORAGE_STATE_PATH` with a Playwright storageState (cookies + origins), and `SESSION_JSON_PATH` with whatever your shell expects in sessionStorage.
- The `SESSION_STORAGE_KEY` is `'dash:session'` for saga-dash; check your shell's auth code if it differs.

If your project doesn't use Playwright auth refresh at all (e.g. cookieless apps or test users baked into seed data), delete `refreshDevSession()` and just remove the call site.

### 3. Rewrite `steps.mjs`

This is the file you'll spend most of your time on. The pattern:

```js
export const STEPS = [
  {
    id: '00-intro',
    narration: 'Welcome to the X feature walkthrough...',
    action: async (page) => {
      await page.goto('/feature');
      await page.waitForSelector('.feature-shell', { timeout: 15000 });
    },
    tailSlack: 600,
  },
  // ...
  {
    id: '13-outro',
    narration: 'That is the X feature. Thanks for watching.',
    action: async (page) => { await page.waitForTimeout(500); },
    tailSlack: 1500,
  },
];

export async function smoothClick(page, locator) {
  const box = await locator.boundingBox().catch(() => null);
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 18 });
    await page.waitForTimeout(120);
  }
  await locator.click();
}
```

**Step authoring tips:**

- **Write the narration for the ear, not the eye.** Spell out abbreviations: "S D S" not "SDS", "K P I" not "KPI", "U R L" not "URL". TTS pronounces letter-by-letter when there are spaces; readers don't notice the difference.
- **One beat per step.** Don't cram three actions and three sentences into one step — give each interaction its own slot so the cursor and narration stay paired.
- **Use `tailSlack` to give visual weight to important moments.** A larger `tailSlack` after a state change (e.g. an org switch, a mode flip) lets viewers' eyes catch up.
- **Scope locators to specific text** (`.filter({ hasText: 'Emma Johnson' })`) rather than `.first()` when the narration calls out a name. The first card is often a tutor or header, not the scholar you're talking about.
- **Default keep narration short** for a first pass; you can grow it later. A long `tailSlack` on a short narration is cheaper to play than re-recording.

**Action authoring tips:**

- Wait for the app shell explicitly in the first step (`waitForSelector` with a generous timeout) so a cold first load doesn't fail the whole recording.
- Use `smoothClick(page, locator)` everywhere. The 18-step `mouse.move` plus the cursor overlay's CSS transition makes the cursor visibly slide between targets.
- Add `await page.waitForTimeout(2000)` after actions that trigger an org switch / route change / data fetch. The next step's locator may not yet exist.
- For mutations (clicks on toggles), wait long enough for the persistence layer to confirm. The narration can mention "save indicator confirms" while the timeout absorbs the actual write.

### 4. Reset state before recording

Most demos read better when starting from a known state. Add a one-liner before invoking `make.mjs`:

```bash
# Example: clear the demo DB
docker exec ... psql -U user -d demo -c "DELETE FROM the_table;"
node scripts/walkthrough-video/make.mjs
```

For a polished render, consider also seeding deterministic test data so the same screenshots reproduce across runs.

### 5. Run

```bash
cd <repo>
node scripts/walkthrough-video/make.mjs                # full render
SKIP_NARRATE=1 node scripts/walkthrough-video/make.mjs # iterate on actions/timing
SKIP_RECORD=1 node scripts/walkthrough-video/make.mjs  # iterate on stitch/SRT
FORCE=1 node scripts/walkthrough-video/narrate.mjs     # force re-synth all chunks
```

Output lands at `scripts/walkthrough-video/video/walkthrough.mp4` + `walkthrough.srt`.

---

## Tuning

### Voice + model

Default is `tts-1-hd` / `onyx`. Switch via env:

```bash
TTS_VOICE=nova TTS_MODEL=tts-1 node scripts/walkthrough-video/narrate.mjs
```

OpenAI voices: `alloy` (neutral), `echo` (clear male), `fable` (British), `onyx` (deep male, default), `nova` (bright female), `shimmer` (warm female). Try a few — they have surprisingly different effects on demo perception.

`tts-1` is faster and ⅓ the cost; `tts-1-hd` is noticeably better at low volume (laptop speakers).

### Cursor

The cursor is a CSS overlay injected by `record.mjs` into every page. Tweak the `CURSOR_OVERLAY` constant for size, color, transition speed, click animation. The defaults (26px, semi-transparent red, 220ms ease-out, scale-down on click) are tuned for visibility against light dashboard backgrounds — adjust for dark themes.

### Pacing

If a step feels rushed, bump its `tailSlack` (in ms). If a step's narration is talking over a long action, either shorten the narration or accept the static-frame overlap. The recorder reports per-step `audio` / `action` / `slot` durations on each run — read those to find pacing issues.

### Resolution

The recorder uses a 1440×900 viewport by default. For a tighter framing, drop to 1280×800 in the `VIEWPORT` constant. Anything smaller and dashboard text becomes hard to read.

---

## Known gotchas

### 1. GStreamer "Internal data stream error" on Linux

GNOME Videos (Totem) on Ubuntu/Wayland sometimes hangs or refuses to play H.264 MP4 due to a flaky VAAPI hardware-decode path — not a problem with the file. Confirmed by `gst-discoverer-1.0` rejecting even minimal H.264 MP4s on the same system that decodes them fine via direct `gst-launch` pipelines.

**Workarounds (in order of ease):**

- Open the MP4 in Firefox/Chrome — they decode in-process and bypass GStreamer entirely.
- Render a VP9 + Opus WebM alongside the MP4 — GStreamer's WebM path is more reliable than its H.264 path. One-liner:
  ```bash
  ffmpeg -i video/walkthrough.webm -i video/walkthrough.audio.mp3 \
    -c:v libvpx-vp9 -crf 32 -b:v 0 -deadline good -cpu-used 4 \
    -pix_fmt yuv420p -r 25 \
    -c:a libopus -b:a 96k -ar 48000 -ac 2 \
    -shortest -f webm video/walkthrough-vp9.webm
  ```
- Disable VAAPI for one Totem launch:
  ```bash
  LIBVA_DRIVER_NAME= GST_VAAPI_DISABLE=1 totem video/walkthrough.mp4
  ```
- Install `mpv` (`apt install mpv`) — robust local player that doesn't go through GStreamer.

If your team standardizes on Linux + Totem, consider making `stitch.mjs` emit both MP4 and WebM by default.

### 2. Auth cookies decay

The dev session cookie minted at recorder startup becomes invalid if the auth service restarts. The reference implementation calls `refreshDevSession()` at the top of each render, which is cheap and avoids surprises. Don't try to cache a session across runs — just remint.

### 3. Locator targeting the wrong row

`.first()` and `.nth(0)` are deceptive when the visible roster includes a tutor row above scholars (or any header). If the narration says "Emma" and the click hits Alex, the demo looks broken. Always anchor by visible text:

```js
page.locator('[data-testid="card"]')
    .filter({ hasText: 'Emma Johnson' })
    .first()
    .getByRole('button', { name: /^Tardy$/ })
```

### 4. Action overruns audio

If an action takes longer than its narration, the recorder extends the slot and the stitcher pads with silence. The viewer hears nothing while the cursor finishes its work — fine briefly, awkward for many seconds. If you see `⚠ action exceeded audio` in the recorder output, either:
- Add more narration to that step
- Speed up the action (tighter `waitForTimeout`s)
- Split the step in two

### 5. Page navigation resets app state

In some single-page-app setups, `page.goto('/route')` resets in-memory state (selected org, filters, etc.). If a step relies on state set up in a prior step, prefer in-app navigation (clicking the route link) over `page.goto`.

### 6. TTS pronunciation surprises

Numbers, acronyms, and code identifiers can read awkwardly. Test-listen to the first render; common fixes:

- "S D S" → "SDS" (force letter-by-letter)
- "twenty-twenty-six" instead of "two thousand twenty-six"
- Spell out programming terms: "trackingMode" → "tracking mode"

The cache means re-synth is fast — iterate freely on phrasing.

---

## Cost + time budget

| Item | One-time | Per render |
|---|---|---|
| OpenAI TTS API key | — | — |
| Initial setup (copy + adapt scripts) | 1–3 hours | — |
| Authoring `steps.mjs` for a new feature | 1–2 hours | — |
| Full render (14 steps / 3 min) | — | ~3 min wallclock + ~$0.15 |
| Re-render after editing narration of 1 step | — | ~3 min + ~$0.01 |
| Re-render after editing actions only (`SKIP_NARRATE=1`) | — | ~3 min + $0 |

The expensive cost is authoring the step list. The cheap cost is iterating on it.

---

## Extending the pipeline

Patterns you might want to add (none yet implemented in the reference):

- **Multi-voice**: interleave `nova` and `onyx` for a "two presenters" feel. Requires teaching `narrate.mjs` to read a `voice` field per step.
- **Music bed**: ffmpeg can mix a low-volume background track over the narration in `stitch.mjs`. `-filter_complex amix` with a quiet music input.
- **Burned-in subtitles**: `ffmpeg -vf "subtitles=walkthrough.srt"` instead of leaving SRT as a sidecar. Useful for embedding in slack/email previews where players ignore sidecars.
- **Logo bumper / outro card**: pre-encode a 3-second bumper, concat ahead of the walkthrough WebM with `concat` demuxer.
- **Multiple resolutions**: render once, encode multiple bitrate variants in `stitch.mjs` (1080p / 720p / mobile).
- **Captions translation**: pass the SRT text to a translation model, generate per-language SRTs.
- **Per-step thumbnails**: extract a frame at the midpoint of each slot for a "chapters" UI.

---

## Provenance + history

This pipeline was prototyped against the SDS sds_92 dual-mode attendance demo on 2026-05-15. The reference scripts and an associated decision doc on a Phase A.3.2 mutation-path gap are in:

- `~/dev/saga-dash/scripts/walkthrough-video/` (reference implementation)
- `~/dev/student-data-system/claude/projects/sds_92/qa/manual-test-playbook-2026-05-15.md` §W (the canonical "narrative walkthrough" markdown that `steps.mjs` translates into spoken word)

If you build on this for a new project, consider adding a link back to your project's adaptation under "Reference implementation" above — the more examples future readers have, the easier the pattern is to apply.
