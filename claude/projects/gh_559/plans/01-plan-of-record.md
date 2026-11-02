# Plan of record

Status lives on the issues. This is the shape and the reasoning.

## Dev blue/green (I#560), one PR

Standalone, per d5: soa is public and can't call the private ci-actions.

1. Dockerfile: `id=codeartifact` secret. No `$BUILDPLATFORM` split (d3).
2. `.github/workflows/deploy-vishnu-api.yml`, dispatch only: preflight, test, build on `ubuntu-24.04-arm`, deploy.
3. `.github/scripts/vishnu-deploy.sh`: the live-colour and scope guard, image check, `sam deploy` and health check. Reuses `render-deploy-command.py`, so parameters stay in samconfig.
4. `infra/github-oidc/`: the dev deploy role, deployed once by someone with AppInfra tier (`saga-infra-dev`), plus the `dev` environment and `SOA_DEPLOY_ROLE_ARN` variable.
5. `pnpm-filter`-equivalent `@saga-ed/vishnu*...` for the test gate (d2), confirmed with a turbo dry run.
6. `OPS.md`: dispatch replaces steps 3 and 4. Bootstrap, routing stacks and the live rule stay manual.

**Dropped by d5:** template parameters for the fleet pipeline, a mutable ECR repo and the ECR SSM parameter. `service-template.yaml` and `bootstrap-template.yaml` are unchanged from main. Reruns skip the push when the sha tag exists. No build cache: the install layer holds private packages, and fork PR runs in a public repo can read this repo's Actions cache.

**CodeArtifact:** tokens come from the existing `AWS_ROLE_ARN` role, so the dev role needs no cross-account access. The dev role trusts only the `environment:dev` subject, and `test` doesn't bind that environment, so install scripts and tests can't mint its token.

**Branch:** commit directly on `gh_559-Vishnu-CI-deploy`, with one PR to main, rather than a sub-branch PR'd into the issue branch. With I#561 deferred, a sub-branch would only add a second PR.

**Sequencing with PR#556 (d4):** this lands on main first. The workflow sends `EventStatsPreviewTag` only when the input is set, and refuses if the ref's template doesn't declare it, because SAM would silently drop it. PR#556 then merges main and deploys its own branch by dispatch. Tests against PR#556's renderer and template passed; confirm dispatch-on-a-branch once the workflow is on main.

**Live colour:** read on every dispatch, in preflight and again immediately before `sam deploy`. Read 2026-11-02: green live, blue idle at `sandbox-gh537`.

## First dispatch

**Don't reset blue from main.** The Vishnu deploy session reported on 2026-11-02 that blue is in active use at `sandbox-gh537` with no end date, and that its code exists only on PR#556, so a main build would remove features as well as change scope. Green carries live traffic, and the guard refuses it.

So the first dispatch should be blue from PR#556's branch after it merges main, with `preview-tag: sandbox-gh537`. That replaces the manual QEMU build and keeps the observation running. It still redeploys a colour in use, so agree the timing with that session and skelly first. PR#556 must also move to `id=codeartifact`, which merging main does for the Dockerfile.

Nothing has run on GitHub. Still unproven: the two-role flow, the Node 24 gate on existing tests, a real arm64 build, a real `sam deploy`, health from a runner, and `SOADeployRole` accepting the subjects used.

## Later: per-sandbox and PR previews (I#561), deferred by d1

See I#561, research/01 and gh_536 d9 option (b). Beyond the workflows, this needs a per-sandbox Vishnu database, a JANUS host for a sandbox Vishnu and the dispatch allowlist. d9 estimated weeks of work. ci-actions can't be used for it either, unless d5 changes.
