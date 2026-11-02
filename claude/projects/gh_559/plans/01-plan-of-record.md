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

**Sequencing with PR#556:** it edits `service-template.yaml`, `OPS.md` and `render-deploy-command.py`, and adds parameters the caller must pass (`EventStatsPreviewTag` and the MQ set). Rebase once it lands. If it stays open, base on its branch rather than duplicating its parameters.

## Later: per-sandbox and PR previews (I#561), deferred by d1

See I#561, research/01 and gh_536 d9 option (b). Beyond the workflows, this needs a per-sandbox Vishnu database, a JANUS host for a sandbox Vishnu and the dispatch allowlist. d9 estimated weeks of work.
