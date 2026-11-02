# gh_559 — Vishnu CI deploy path

**Issue:** I#559 — https://github.com/saga-ed/soa/issues/559  (view: `gh issue view 559`); sub-issues I#560 (dev blue/green), I#561 (per-sandbox and PR previews)
**Branch/worktree:** gh_559-Vishnu-CI-deploy / /home/skelly/dev/soa/.claude/worktrees/gh_559-Vishnu-CI-deploy
**Slot/set:** none, deliberately. See Locked decisions.
**Parent context:** ../../../CLAUDE.md

## The problem

Vishnu has no CI deploy path. Each cloud deploy begins with a manual `docker build --platform linux/arm64` on a developer machine (`infra/vishnu-api/OPS.md` step 3), which runs under QEMU on x86. Vite and tsup under emulation held over 100% CPU for minutes on 2026-10-30, on a build of `vishnu-api:5232aad0` from the PR#556 branch.

## What this initiative is

1. CI builds and deploys Vishnu to dev blue/green on a native ARM runner (I#560).
2. That workflow can set the preview tag, so an idle colour can observe a patch-party sandbox (PR#556, gh_536 d9).
3. The manual build leaves `OPS.md`.
4. Per-sandbox and PR-preview deploys of Vishnu itself, so it joins patch party like other services (I#561, ruled in d1).

## Layout

- `sources/` — the originating ask and an issue snapshot
- `research/01-ci-contract-gap.md` — what `deploy-ecs-api` expects vs what Vishnu has
- `research/02-why-arm64-and-emulation.md` — why ARM, and how emulation came about
- `plans/01-plan-of-record.md` — the phased plan
- `decisions/d1-vishnu-sandbox-deploys.md` — RESOLVED: build sandbox and PR previews now

## Locked decisions

- **Synthetic dev stays native Node** (skelly, 2026-10-30). `ss` keeps running `pnpm dev`; no image is built for it.
- **Fewer PRs** (skelly, 2026-10-30, for Vishnu generally): "this is a new system so the fewer PRs to manage the better". Hence two sub-issues, not one per fix.
- **No synthetic-dev slot.** The `project` skill defaults to claiming one, but nothing here runs in synthetic dev, and all slots are bound, so claiming one means displacing another set. Claim one if that changes.
- **Vishnu gets its own sandbox and PR-preview deploys** (d1, skelly, 2026-11-02).

## Open (track, don't block)

- Switchboard catalog entry and browser delivery of the preview header (I#561).
- How to cover the SPA in CI (filter expression or wrapper package).
- Sequencing with PR#556, which edits the same three infra files.

## Key reference paths

| What | Where |
|---|---|
| Manual runbook | `/home/skelly/dev/soa/infra/vishnu-api/OPS.md` |
| Service template | `/home/skelly/dev/soa/infra/shared/service-template.yaml` |
| Image | `/home/skelly/dev/soa/apps/node/vishnu-api/Dockerfile` |
| Closest caller to copy | `/home/skelly/dev/program-hub/.github/workflows/deploy-programs-api.yml` |
| Deploy role to copy | `/home/skelly/dev/program-hub/infra/github-oidc/dev-deploy-role-template.yaml` |
| Caller contract | `/home/skelly/.claude/plugins/cache/saga-tools/saga-iac/1.22.0/references/ci-actions-caller-contract.md` |
| Sandbox observation design | `claude/projects/gh_536/decisions/d9-vishnu-sandbox-observation.md` on branch `gh_538-vishnu-sandbox` (PR#556) |

*Last updated: 2026-11-02*
