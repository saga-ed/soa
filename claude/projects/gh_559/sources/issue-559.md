# I#559 snapshot (2026-11-02). Trust the live issue.

## Problem

Vishnu (`apps/node/vishnu-api` + `apps/web/vishnu`, one Node container) has no CI deploy path. Every cloud deploy starts with a manual `docker build --platform linux/arm64` on a developer machine (`infra/vishnu-api/OPS.md` step 3). On x86 that runs under QEMU: a build of `vishnu-api:5232aad0` held over 100% CPU for minutes on a dev box on 2026-10-30. It also means images aren't built from a clean, reviewed source.

## Goal

CI builds and deploys every cloud environment Vishnu runs in, through `saga-ed/ci-actions` `deploy-ecs-api.yml`, on a native ARM runner. The manual build step leaves the runbook.

**Not changing:** synthetic dev keeps running Vishnu as native Node through `ss` (`pnpm dev`); no image is involved. Prod stays out of scope, as it is for Vishnu today.

## Work

Tracked as sub-issues:
- Dev blue/green CI path, including the preview tag PR#556 needs
- Per-sandbox and PR-preview deploys (only if needed; see decision d1)

## Coordination

Draft PR#556 (`gh_538-vishnu-sandbox`) edits `infra/shared/service-template.yaml`, `infra/vishnu-api/OPS.md` and `infra/vishnu-api/render-deploy-command.py`. All three overlap with this work, and the CI caller has to pass the parameters PR#556 adds.

Why-record, research and decisions: `claude/projects/gh_559` on this issue's branch.

