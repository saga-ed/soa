# gh_559 — Vishnu CI deploy path

**Issue:** I#559 — https://github.com/saga-ed/soa/issues/559  (view: `gh issue view 559`); sub-issues I#560 (dev blue/green), I#561 (per-sandbox and PR previews)
**Branch/worktree:** gh_559-Vishnu-CI-deploy / /home/skelly/dev/soa/.claude/worktrees/gh_559-Vishnu-CI-deploy
**Slot/set:** none, deliberately. See Locked decisions.
**Parent context:** ../../../CLAUDE.md

## The problem

Vishnu has no CI deploy path. Each cloud deploy begins with a manual `docker build --platform linux/arm64` on a developer machine (`infra/vishnu-api/OPS.md` step 3), which runs under QEMU on x86. Vite and tsup under emulation held over 100% CPU for minutes on 2026-10-30, on a build of `vishnu-api:5232aad0` from the PR#556 branch.

## What this initiative is

1. A standalone workflow builds and deploys Vishnu to dev blue/green on a native ARM runner (I#560).
2. That workflow can set the preview tag, so an idle colour can observe a patch-party sandbox (PR#556, gh_536 d9).
3. The manual build leaves `OPS.md`.
4. Deferred by d1: per-sandbox and PR-preview deploys of Vishnu itself (I#561).

## Layout

- `sources/` — the originating ask and an issue snapshot
- `research/01-ci-contract-gap.md` — what `deploy-ecs-api` expects vs what Vishnu has; superseded by d5 except its blocker section
- `research/02-why-arm64-and-emulation.md` — why ARM, and how emulation came about
- `plans/01-plan-of-record.md` — the phased plan
- `decisions/d1-vishnu-sandbox-deploys.md` — RESOLVED: defer I#561
- `decisions/d4-sequencing-with-pr556.md` — RESOLVED: I#560 lands on main first
- `decisions/d5-public-soa-private-ci-actions.md` — RESOLVED: standalone workflow using public actions
- `decisions/d6-dev-environment-gate.md` — PENDING
- `decisions/d2-spa-in-deploy-gate.md` — RESOLVED: name-glob filter covers both packages
- `decisions/d3-buildplatform-dockerfile-split.md` — RESOLVED: dropped

## Locked decisions

- **Synthetic dev stays native Node** (skelly, 2026-10-30). `ss` keeps running `pnpm dev`; no image is built for it.
- **Fewer PRs** (skelly, 2026-10-30, for Vishnu generally): "this is a new system so the fewer PRs to manage the better". Hence two sub-issues, not one per fix.
- **No synthetic-dev slot.** The `project` skill defaults to claiming one, but nothing here runs in synthetic dev, and all slots are bound, so claiming one means displacing another set. Claim one if that changes.
- **An idle colour observes one sandbox** (gh_536 d9, skelly, 2026-10-29). I#560's preview-tag input serves this.
- **The deploy gate covers both packages** with `@saga-ed/vishnu*...` (d2, skelly, 2026-11-02).
- **No `$BUILDPLATFORM` split** in the Dockerfile (d3, skelly, 2026-11-02).
- **I#561 is deferred** (d1, skelly, 2026-11-02).
- **I#560 lands on main before PR#556** (d4, skelly, 2026-11-02).
- **Standalone workflow, not the fleet pipeline** (d5, skelly, 2026-11-02): public soa can't call private ci-actions.

## Open (track, don't block)

- Live colour read 2026-11-02: green live at main scope, blue idle at `sandbox-gh537`. The workflow reads this on each dispatch rather than assuming it.

## Key reference paths

| What | Where |
|---|---|
| Manual runbook | `/home/skelly/dev/soa/infra/vishnu-api/OPS.md` |
| Service template | `/home/skelly/dev/soa/infra/shared/service-template.yaml` |
| Image | `/home/skelly/dev/soa/apps/node/vishnu-api/Dockerfile` |
| Deploy workflow | `/home/skelly/dev/soa/.github/workflows/deploy-vishnu-api.yml` |
| Deploy steps and guard | `/home/skelly/dev/soa/.github/scripts/vishnu-deploy.sh` |
| Deploy role | `/home/skelly/dev/soa/infra/github-oidc/dev-deploy-role-template.yaml` |
| Sandbox observation design | `claude/projects/gh_536/decisions/d9-vishnu-sandbox-observation.md` on branch `gh_538-vishnu-sandbox` (PR#556) |

*Last updated: 2026-11-02*
