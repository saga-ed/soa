# Plan of record

Status lives on the issues. This is the shape and the reasoning.

## Phase 1: dev blue/green (I#560), one PR

1. Dockerfile: `id=codeartifact` secret. No `$BUILDPLATFORM` split (d3).
2. Bootstrap: ECR URI SSM parameter; ECR tag rule, so `buildcache-*` can be overwritten.
3. Service template: declare the three missing parameters.
4. Dev deploy role stack, deployed once by someone with AppInfra tier (`saga-infra-dev`).
5. `.github/workflows/deploy-vishnu-api.yml`: colour and preview-tag inputs, full parameter JSON, native ARM build, external routing.
6. `pnpm-filter: '@saga-ed/vishnu*...'` (d2), confirmed with a `--dry-run`.
7. `OPS.md`: dispatch replaces steps 3 and 4. Bootstrap, routing stacks and the live rule stay manual.

Why one PR: these are useless separately, and skelly wants fewer Vishnu PRs. The role stack has to be deployed before the workflow can run.

**Branch:** commit directly on `gh_559-Vishnu-CI-deploy`, with one PR to main, rather than a sub-branch PR'd into the issue branch. With I#561 deferred, a sub-branch would only add a second PR.

**Sequencing with PR#556 (d4):** this lands on main first. The workflow sends `EventStatsPreviewTag` only when the input is set, because main's template doesn't declare it until PR#556 lands. PR#556 then merges main and deploys its own branch by dispatch. Confirm that dispatch-on-a-branch works once the workflow is on main.

**Live colour:** `OPS.md` on main says blue is live, d9 says green. Check the live rule before the first dispatch, and make the colour input required, with no default.

## Later: per-sandbox and PR previews (I#561), deferred by d1

See I#561, research/01 and gh_536 d9 option (b). Beyond the workflows, this needs a per-sandbox Vishnu database, a JANUS host for a sandbox Vishnu and the dispatch allowlist. d9 estimated weeks of work.
