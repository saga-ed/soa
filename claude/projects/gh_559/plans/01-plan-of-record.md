# Plan of record

Status lives on the issues. This is the shape and the reasoning.

## Phase 1: dev blue/green (I#560), one PR

1. Dockerfile: `id=codeartifact` secret; `--platform=$BUILDPLATFORM` build stage.
2. Bootstrap: ECR URI SSM parameter; ECR tag rule, so `buildcache-*` can be overwritten.
3. Service template: declare the three missing parameters.
4. Dev deploy role stack, deployed once by someone with AppInfra tier (`saga-infra-dev`).
5. `.github/workflows/deploy-vishnu-api.yml`: colour and preview-tag inputs, full parameter JSON, native ARM build, external routing.
6. SPA coverage in CI.
7. `OPS.md`: dispatch replaces steps 3 and 4. Bootstrap, routing stacks and the live rule stay manual.

Why one PR: these are useless separately, and skelly wants fewer Vishnu PRs. The role stack has to be deployed before the workflow can run.

**Sequencing with PR#556:** it edits `service-template.yaml`, `OPS.md` and `render-deploy-command.py`, and adds parameters the caller must pass (`EventStatsPreviewTag` and the MQ set). Rebase once it lands. If it stays open, base on its branch rather than duplicating its parameters.

**The `$BUILDPLATFORM` caveat:** the build stage runs `pnpm deploy --prod --ignore-scripts`, whose output goes straight into the arm64 runtime stage. Any native module would then carry x86 binaries. Audit the dependency tree before making this change, or install production dependencies in an arm64 stage.

## Phase 2: per-sandbox and PR previews (I#561), ruled in by d1

See I#561 and research/01. Answer the switchboard catalog and preview-header questions first; they decide whether a browser can use a Vishnu sandbox at all.
