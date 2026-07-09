# walkthrough-video

Turn a click-through demo of any saga-soa frontend into a narrated MP4/WebM with synced
cursor, voiceover, and SRT subtitles — reusable across repos, driven by `saga-stack-cli`.

Output is a 2–5 minute video suitable for: exec demos, async PR walkthroughs, onboarding,
release notes. Re-render whenever the feature it covers changes significantly.

Design note: this generalizes the pattern first prototyped and documented in
`../../docs/how-to-narrated-walkthrough-video.md` (validated against an SDS demo, May 2026).
That doc describes a copy-per-repo pattern; this tool instead keeps the **engine**
(`lib/`) here in soa, app-agnostic, with only a thin per-app **adapter** and per-feature
**step data** varying. Read the doc for the underlying sync model and known gotchas — it
still applies, just with the engine centralized.

## Architecture

```
adapters/<app>.mjs                 →  baseUrl + getStorageState()  (per-app, ~30 lines)
walkthroughs/<app>/<feature>/
  steps.mjs                        →  narration + Playwright actions  (per-feature, the real work)

lib/narrate.mjs   (OpenAI TTS, content-hash cached)  ─┐
lib/record.mjs    (Playwright + cursor overlay)       ├─  app-agnostic engine, written once
lib/stitch.mjs    (ffmpeg mux + SRT)                  │
lib/make.mjs      (orchestrator)                     ─┘
```

Sync model: `slot[N] = max(actionDuration[N], narrationDuration[N]) + tailSlack[N]`.
`record.mjs` waits that long before step N+1; `stitch.mjs` pads each narration chunk with
trailing silence to fill its slot. See the doc above for the full rationale + gotchas
(GStreamer/Totem H.264 playback trap on Linux, locator-targeting-the-wrong-row, etc.) —
they're not repeated here.

## Prerequisites

- Node 20+, `ffmpeg` + `ffprobe` on PATH (`apt install ffmpeg`).
- `playwright` (root devDependency, already added — `pnpm install` at the soa root picks
  it up like any other workspace dep).
- `saga-stack-cli` (`ss`) installed and on PATH — see
  `packages/node/saga-stack-cli/README.md` § Install.
- An OpenAI API key for narration (the default `TTS_ENGINE=openai`). **Do not** put one in
  a local `.env` — the dev key lives in Secrets Manager (`openai-dev-apikey-W3MunH`,
  us-west-2, account 531314149529). `lib/narrate.mjs` fetches it automatically via
  `aws secretsmanager get-secret-value --profile saga-dev` — **Observer-tier profiles
  (`saga`, `saga-dev`) are denied `GetSecretValue` on this ARN** by design. For routine
  iteration, set `OPENAI_API_KEY` directly to bypass Secrets Manager entirely (e.g. a
  throwaway personal key) rather than reaching for an elevated profile. `WALKTHROUGH_AWS_PROFILE`
  does let you point at a profile with access (e.g. `saga-admin-{dev,prod}`), but that's
  break-glass — reserve it for an official narrated render, not day-to-day authoring, per
  the tier-ladder norms in the repo owner's global CLAUDE.md.
- For a **free/zero-credential iteration tier**, prefer `SKIP_NARRATE=1` (silent render —
  proves out action timing/selectors without any TTS call) over `TTS_ENGINE=edge`. The
  `edge` engine (unofficial `edge-tts` npm wrapper around Microsoft's read-aloud API) is
  wired in but **known broken as of 2026-07**: its hardcoded auth token returns 403
  (Microsoft rotates/blocks it periodically — out of our control). Kept as a pluggable
  option in case it's patched upstream; don't rely on it today.

## Running an existing walkthrough

```bash
ss stack up --with dash        # bring up just what saga-dash needs

# The bundled example (program-creation) needs the `empty@saga.org` persona — an
# already-rostered org with zero programs, baked into the IAM seed. The adapter
# re-mints its own session on every run via `ss stack login`, so set the persona
# once via env rather than calling `ss stack login` yourself first:
export WALKTHROUGH_LOGIN_EMAIL=empty@saga.org

node tools/walkthrough-video/lib/make.mjs --walkthrough saga-dash/program-creation

# Iterate cheaply:
SKIP_NARRATE=1 node tools/walkthrough-video/lib/make.mjs --walkthrough saga-dash/program-creation  # silent render — no TTS call, action-timed slots only
SKIP_RECORD=1  node tools/walkthrough-video/lib/make.mjs --walkthrough saga-dash/program-creation  # re-stitch only (reuses last recorded video)
FORCE=1        node tools/walkthrough-video/lib/make.mjs --walkthrough saga-dash/program-creation  # force re-synth all narration
```

`WALKTHROUGH_LOGIN_EMAIL` is only needed when a walkthrough requires a specific seeded
persona — omit it to log in as `ss`'s own default (`dev@saga.org`).

Output lands at `walkthroughs/<app>/<feature>/video/walkthrough.mp4` (+ `-vp9.webm` sidecar,
`.srt`). The `.srt` is also muxed into the MP4 itself as a selectable soft-subtitle track
(`mov_text`) — captions work whether or not the `.srt` sidecar travels with the file. The
`-vp9.webm` sidecar has no embedded captions (the container doesn't support `mov_text`);
pair it with the `.srt` sidecar if you distribute that variant.

**Mutating walkthroughs need a reset between runs.** A script like `program-creation` has
a precondition (here: zero programs in the org) that its own first action changes. Run it
twice against the same persona without resetting in between and the second recording drives
whatever page the app lands on now — not the one the script expects — with no error, just a
silently wrong video. Before re-recording a mutating walkthrough: `ss stack reset && ss stack seed`,
or switch to a not-yet-used persona. This applies on the local stack same as the sandbox lane
(see the "Known constraint" note below) — a persona is "clean" only until the first successful
run through it.

## Recording against a deployed sandbox composition

`adapters/saga-dash.mjs` has a second lane for recording against an already-deployed
switchboard sandbox composition instead of a local stack — useful when a walkthrough
needs data/services only a sandbox has, or you don't want to stand up a local stack.
No local stack is brought up or torn down; the composition must already exist.

```bash
export WALKTHROUGH_LANE=sandbox
export WALKTHROUGH_DASH_URL=https://dash.wootdev.com     # defaults to this if unset
export WALKTHROUGH_IAM_URL=https://iam.wootdev.com       # defaults to this if unset
export JANUS_SESSION=<janus_session cookie value>        # from an interactive JumpCloud
                                                          # gate login — copy from devtools;
                                                          # required unless the composition
                                                          # was deployed Janus-off (unsupported
                                                          # by this adapter today)
export WALKTHROUGH_PREVIEW_PINS="iam-api=sandbox-<name>,sis-api=sandbox-<name>,programs-api=sandbox-<name>,..."
export WALKTHROUGH_LOGIN_EMAIL=empty@saga.org            # must be seeded in that composition

node tools/walkthrough-video/lib/make.mjs --walkthrough saga-dash/program-creation
```

This mirrors saga-dash's own sandbox e2e lane (`apps/web/dash/e2e/run-stack-e2e.sh
--sandbox`, `PLAYWRIGHT_PREVIEW_PINS`) — same `x-saga-preview-<svc>` cookie-pinning
mechanism, same real `auth.login` (not `devLogin`, which is forbidden on deployed
iam-api), same Janus perimeter cookie. `WALKTHROUGH_PREVIEW_PINS` uses the identical
`svc=variant,svc=variant` format as saga-dash's `PLAYWRIGHT_PREVIEW_PINS` — if you
copied a composition string from switchboard (`svc:variant,svc:variant,...,_default:main`,
often URL-encoded), translate it: swap `:` for `=`, drop the `_default:...` entry (not a
real pin — services you don't pin just aren't listed, and fall through to `main` on
their own), and URL-decode if needed.

**Known constraint**: recording a walkthrough that mutates state (e.g.
`program-creation`, which creates a program) against a shared sandbox composition means
a second recording will start from different UI state unless the composition/persona
resets between runs. Prefer a read-only walkthrough for a composition you don't control,
or confirm reset behavior first.

## Authoring a new walkthrough

1. **If the app has no adapter yet**, add `adapters/<app>.mjs` exporting
   `{ baseUrl, getStorageState() }`. `getStorageState()` must return a Playwright
   `storageState` object (`{cookies, origins}`). `adapters/saga-dash.mjs` is the reference:
   it shells out to `ss stack login --output-json`, reads the Netscape cookie jar it
   writes, and converts it. If your app doesn't use `saga-stack-cli`'s login, or doesn't
   need cookies at all, write whatever fits — the contract is just that return shape.

2. **Write `walkthroughs/<app>/<feature>/steps.mjs`**:

   ```js
   import { smoothClick } from '../../../lib/record.mjs';

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
       id: '99-outro',
       narration: 'That is the X feature. Thanks for watching.',
       action: async (page) => { await page.waitForTimeout(500); },
       tailSlack: 1500,
     },
   ];
   ```

3. Run it per the recipe above.

### Authoring tips (from the original doc — still apply)

- Write narration for the ear: "S D S" not "SDS", "K P I" not "KPI".
- One beat per step — don't cram multiple actions/sentences into one.
- Use `tailSlack` (ms) to give visual weight to important moments.
- Scope locators to visible text (`.filter({ hasText: 'Emma Johnson' })`) rather than
  `.first()` — the first row in a list is often a header or the wrong entity.
- Use `smoothClick(page, locator)` (exported from `lib/record.mjs`) for all clicks — it
  glides the cursor overlay to the target before clicking, so the recording reads as a
  real cursor, not a teleporting dot.
- Add `await page.waitForTimeout(2000)` after actions that trigger a route change or data
  fetch, so the next step's locator is guaranteed to exist.
- If the recorder logs `⚠ action exceeded audio`, either add more narration to that step,
  tighten the action's waits, or split the step in two.

## Known gotchas

Carried over from the original design doc (still relevant):

- **GStreamer/Totem H.264 playback trap on Linux** — if a rendered MP4 won't play in GNOME
  Videos, open it in a browser or `mpv` instead, or use the `-vp9.webm` sidecar (emitted by
  default in `stitch.mjs` for this reason).
- **Session cookies decay** — the adapter re-mints a session on every `make.mjs` run; don't
  try to cache one across renders.
- **Page navigation can reset in-app state** — prefer in-app navigation (clicking a route
  link) over `page.goto()` when a step depends on state set up by a prior step.

## Extending

Not built in this pass, but straightforward given the engine/data split:

- A new `adapters/<app>.mjs` + `walkthroughs/<app>/<feature>/steps.mjs` is all a new
  app/feature needs — no engine changes.
- Multi-voice narration, a background music bed, burned-in (as opposed to the current
  soft/selectable) captions, multiple output resolutions — see the original doc's
  "Extending the pipeline" section for the shape of each; none are implemented here yet.
- Folding this into `saga-stack-cli` proper as `ss demo record <spa>/<feature>`, once this
  standalone tool has proven itself on a few real walkthroughs.
- Push-button cloud rendering (Fargate + headless Chromium) — viable, not designed here;
  this pass targets local-only.
