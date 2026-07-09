# walkthrough-video

Generates narrated MP4/WebM walkthrough videos (synced cursor, voiceover, subtitles) of
any saga-soa frontend, driven by `saga-stack-cli`. Full guide — architecture, prerequisites,
running an existing walkthrough, the sandbox-composition lane, authoring a new one, gotchas
— lives in [README.md](./README.md). Read that before making changes here; this file is
just the on-ramp.

**To record an existing walkthrough** (e.g. `saga-dash/program-creation`): README.md
§ "Running an existing walkthrough". Start with `SKIP_NARRATE=1` for a free/fast silent
smoke pass before spending on real TTS narration.

**To author a new walkthrough** for an app/feature that doesn't have one yet: README.md
§ "Authoring a new walkthrough" — add an adapter (only if the app has none) plus a
`steps.mjs` under `walkthroughs/<app>/<feature>/`; the engine in `lib/` is app-agnostic
and shouldn't need to change.

**Before re-recording a walkthrough that mutates state** (creates/deletes something),
reset first — see README.md's note under "Running an existing walkthrough". A persona
that satisfied the script's precondition on the first run usually won't on the second.
