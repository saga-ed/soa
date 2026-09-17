# gh_305 — original ask

> Create a new issue for a `ss develop` topic — I'm going to migrate the `ss e2e connect`
> to this topic from the e2e topic and add sub-commands for coach, saga-dash, ads etc.
> The idea is that these are less end-to-end tests and more **concierge scripting** that
> makes it easy to set up and develop against a particular application or workflow.
> Create the issue in soa and a project `claude/projects/gh_[issue]` with source and
> research directories. Use **slot 1** and a **worktree** for this effort — we'll be
> working and testing it for most of today.

## Tracking

- **Issue:** saga-ed/soa#305 — https://github.com/saga-ed/soa/issues/305
- **Worktree:** `.claude/worktrees/gh305-ss-develop` (branch `worktree-gh305-ss-develop`)
- **ss stack slot:** 1 (all live bring-up / testing runs against slot 1 for the day)

## The idea

`e2e` conflates two intents. Split them:

- **`e2e`** stays the *test-runner*: `e2e list` / `e2e run` / `e2e traces`.
- **`develop`** (new) is *concierge scripting*: one-command flows that seed/reset a stack,
  build any prerequisite, log in, and hand off a **running, developable app** for a
  specific application or workflow.

`ss e2e connect` moves to `ss develop connect` (it's a live headed interactive session,
not a test). New per-app concierge subcommands: `develop coach`, `develop saga-dash`,
`develop ads`, … — extensible, one per app/workflow we want a fast on-ramp for.

See the issue for the full proposed shape, scope, and non-goals.
