# Vishnu UI handoff — Codex → Claude, 2026-11-02

## Request and ownership

Skelly reviewed https://vishnu.wootops.org/ and asked for better use of available space and an explanation/fix for uniform `? Unknown` node labels. Skelly authorized the UI updates and requested this handoff so the Claude session can redeploy them. Claude retains ownership of blue image builds, change sets, and rollout gates. This session did not deploy, change routing, push a branch, or open a PR.

## Exact code to integrate

The work is in the same SOA Git repository, in an isolated **detached** worktree:

`/home/skelly/dev/worktrees/soa-vishnu-usability`

Base: `e24c6937`, the PR#556 / `gh_538-vishnu-sandbox` revision from the November 2 handoff.

Cherry-pick these commits, in order, onto the current PR#556 branch after checking for intervening changes:

1. `84724c8e` — prioritize mesh canvas and show telemetry evidence.
2. `ed957265` — distinguish unavailable APM from stale observations.

```bash
git cherry-pick 84724c8e ed957265
```

Run that command in the intended integration worktree, not blindly in the detached review checkout. Preserve any unrelated local work. These commits are local and have not been pushed. The handoff itself is committed separately after the two code commits; copy/cherry-pick it too if useful for the durable project record.

## What changed

- Replaced the large sidebar/slogan header with compact Vishnu branding. Condensed status rows and toolbar spacing. The inspector starts closed and opens on selection, including search/list selections.
- Removed the tall MQ participant panel from graph node bounds. A compact participant-count button opens the list in the inspector. The list retains producer/consumer role, report status, fresh-instance count, accepted-publish count, and delivery count. Clicking a service opens its full MQ details.
- Reduced explicit Fit mesh padding and compacted ordinary edge labels at low zoom.
- Added a shared node-evidence label for graph cards, accessible node names, system list, and selected-system inspector. Labels include `APM observed`, `MQ reporting`, `Declared only`, `No current telemetry`, and separate stale/unavailable states. APM warning/alert signals also drive the card border. Fixture health and local runtime/reachability labels remain supported.
- Scoped Datadog data is now passed to the selected-system inspector, consistent with the graph overlay.
- Final correction: failed APM refreshes or an unavailable/unconfigured snapshot produce `APM unavailable`; `APM stale` is reserved for an aged snapshot from an otherwise available feed. Neither label means the service itself is down.

No backend query, reporter allowlist, receiver scope, telemetry package, schema, infrastructure, or routing changes are included.

## Validation completed

On the final code revision:

- `pnpm --filter @saga-ed/vishnu check-types`: zero errors/warnings.
- `pnpm --filter @saga-ed/vishnu test`: 45 tests across 9 files passed.
- `pnpm --filter @saga-ed/vishnu build`: passed; Vite still reports a large-chunk warning.
- `git diff --check`: passed before committing.
- Browser inspection: fixture UI and a **simulated** 22-node / 25-path hosted-shape mesh; inspected at 1552×948 and verified the eight-participant inspector opens. This is visual verification, not a live hosted telemetry smoke test or automated browser-suite run.

The temporary review server at `http://127.0.0.1:8935/` uses simulated APM data, marks the environment `SIMULATED`, and disables MQ collection. Its script is `/tmp/vishnu-preview.mjs`, outside the repository and not part of the release. It is not a proxy to the sandbox. The server stopped responding between turns, causing all cached nodes to appear stale; that prompted the final unavailable-versus-stale correction. Do not treat this preview as evidence of live APM coverage. Its lifetime is not guaranteed.

## Suggested blue smoke check

Use the established blue deployment workflow and required rollout approvals. Keep blue observing `sandbox-gh537`; this handoff does not request a green traffic flip.

1. Confirm the built image contains both code commits, and that the response is actually from blue using `x-saga-preview-vishnu-api: blue`.
2. At laptop and ultrawide sizes, confirm the graph gets the main workspace, the inspector begins closed, and opening the participant list does not restore the tall graph panel.
3. Confirm the eight declared MQ participants remain visible, including producer-only transcripts-api.
4. Confirm a service with any fresh reporting instance shows `MQ reporting` even if older instances remain stale. Existing `serviceStats` aggregation supplies this behavior; sources are not services.
5. Confirm live APM evidence labels, warning presentation, inspector details, search/list selection, and fit controls. Exercise an unavailable refresh and recovery without treating all services as unhealthy.
6. Verify exact sandbox MQ scope remains separate from the environment-wide APM scope. Do not interpret zero sandbox counters as missing reports.

## Follow-up questions from skelly — not implemented here

### Hosted health probes

Skelly asked whether Vishnu should ping each API's `/health` route. Hosted Vishnu currently does **not** probe those routes. Local synthetic-dev already probes each service's configured health path via `packages/node/saga-stack-cli/src/runtime/mesh-view.ts` (1500 ms timeout; redirects disabled).

Recommendation discussed: server-side, bounded/cached probes every 30–60 seconds, presenting reachability separately from APM and MQ evidence. Exact deployment routing must be configured per service; sds uses `X-Preview-<service>`, unlike `x-saga-preview-<service>` elsewhere. A response must not silently come from dev-main when the UI claims sandbox health. A successful health route proves only what that endpoint checks. Probe implementation remains follow-up work.

### Sandbox APM coverage and freshness

Hosted Datadog queries currently use `env:dev`, aggregate by service, and omit the deployment filter in environment-scope mode. MQ is exact-scoped to `sandbox-gh537`. Sandbox traces may contribute to APM, but the aggregate cannot establish sandbox-specific coverage. No sandbox-filtered Datadog investigation was performed in this session.

The real reader uses a 15-minute query window, a 60-second cache, and a 180-second freshness budget. The UI polls APM every 60 seconds. Uniform stale/unavailable labels can result from a common reader/refresh failure; they do not demonstrate that every service stopped emitting. Metric-point age is checked separately from snapshot age. `APM observed` means the fresh snapshot contains that service; it does not promise every metric has a recent bucket, nor does it declare the service healthy.

To establish sandbox coverage, inspect telemetry using the actual sandbox deployment tags and verify propagation/instrumentation on the deployed service revisions. Changing the environment-wide APM model is a separate design decision.
