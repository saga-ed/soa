# Implementation guidance for I#535–538

Read-only preparation findings, 2026-10-22. This is a source map and rationale record; GitHub issues own delivery status. No application implementation, publishing, deployment or slot mutation was performed during this preparation.

## Working conventions

- `/home/skelly/dev/skilgoreT-skills/facts/preferences.md`
- `/home/skelly/dev/CLAUDE.md`
- `/home/skelly/dev/WORKTREES.md`
- `/home/skelly/dev/skilgoreT-skills/skills/project/SKILL.md`

Use absolute paths in human-facing communication, preserve `.claude` paths, use the epic's issue branch with child issue branches targeting it, and use an isolated ss slot rather than slot 0. Project setup is the next preparation step. Existing Vishnu work is on `work/vishnu-discovery-handoff` and includes untracked application/research files; a new worktree will not contain those automatically. Inventory and preserve that work before deciding what to transfer.

## Package, runtime and event contracts

- `/home/skelly/dev/soa/CLAUDE.md`
- `/home/skelly/dev/soa/packages/CLAUDE.md`
- `/home/skelly/dev/soa/packages/node/CLAUDE.md`
- `/home/skelly/dev/soa/packages/node/claude/event-driven.md`
- `/home/skelly/dev/soa/claude/esm.md`
- `/home/skelly/dev/soa/claude/tooling/pnpm.md`
- `/home/skelly/dev/soa/claude/projects/soa_75/decisions/d-contract-testing.md`
- `/home/skelly/dev/soa/claude/projects/soa_75/decisions/d-event-versioning.md`

Use Node-only package boundaries, strict TypeScript, ESM `.js` relative imports, explicit initialization and pnpm. Local runtime follows root engines (Node >=24); CI currently uses Node 22, so CI compatibility must be checked rather than silently changing its runtime. Wire schemas are frozen per version; contract snapshots, consumer pins and runtime validation are separate required layers. Existing prose claiming at-least-once publishing does not override the current non-confirm implementation: accepted and confirmed remain distinct.

## Testing and release

- `/home/skelly/dev/soa/claude/testing/conventions.md`
- `/home/skelly/dev/soa/claude/testing/philosophy.md`
- `/home/skelly/dev/soa/packages/node/claude/testing.md`
- `/home/skelly/dev/soa/packages/node/event-integration-tests/package.json`
- `/home/skelly/dev/soa/docs/cicd-package-publishing.md`
- `/home/skelly/dev/soa/.github/workflows/publish-codeartifact.yml`
- `/home/skelly/dev/soa/.github/workflows/publish-all-packages.yml`

The specific test convention wins over older shared-memory examples: `.unit.test.ts` / `.int.test.ts`, adjacent `__tests__`, acceptance `@spec` Gherkin and matching scenario/test names. Use real Postgres/RabbitMQ integration tests for transaction and transport claims; hermetic tests for accumulator/reporter behavior. Explicit event integration config may serialize container tests despite generic parallel-testing guidance.

Release documentation is stale relative to workflow inputs and hard-coded standard package filters. Do not assume a new event-stats package is automatically covered by the standard CodeArtifact path. Establish dependency-order publication and affected-package validation from the actual workflow before release. The workflow supports single-package publication at an already-committed version; no workflow was dispatched here. Registry availability/authentication is not yet verified.

## Memories and adopter guidance

Read cross-repo/SOA memory indexes, shared TypeScript/testing/DI/turbo memories, and relevant student-data-system feedback index. Mutable slot and branch notes are discovery hints, not current state. Resolve user decisions one at a time in decision documents. CodeArtifact 401 recovery is `/home/skelly/dev/soa/scripts/co-login.sh`; never expose tokens. Stage only owned changes and verify branch posture before edits.

Read repository roots for `/home/skelly/dev/program-hub` and `/home/skelly/dev/rostering`, plus candidate programs/scheduling/IAM service guidance. Re-read complete applicable nested docs and path-scoped rules in the selected worktree before adopter changes; the first slice's actual participants are not yet selected. Preserve auth boundaries and exact shared-package pins. Draft PRs skip preview deployment; readiness is a meaningful deployment transition. Hosted routing/prod guidance is deferred until hosted work is explicitly scoped.

## Tools and skill versions

The relevant saga-iac 1.22.0 source is `/home/skelly/.claude/plugins/cache/saga-tools/saga-iac/1.22.0`; this session's listed Codex cache remains 1.21.3. Use verified 1.22.0 files explicitly. Project skill is readable from the personal skill source. Spec-driven-dev, documentation-system, system-review and compliance-audit are available in this session; load the full relevant skill when applying its workflow.

Claude team API and Claude-in-Chrome instructions do not execute unchanged here. Adapted Codex review/browser verification must be identified as such; do not claim to have run Claude's built-in review commands or hooks. GitHub CLI and local file access have been exercised. Docker/slot health, registry credentials, publication permissions and Claude-side independent review have not been verified by this preparation.

## Resolved routing decision

`/home/skelly/dev/soa/claude/projects/vishnu/decisions/d1-event-stats-routing.md` records the user's selection of existing publisher exchanges with a dedicated telemetry routing key and Vishnu-owned queues. Wildcard binding audits remain an implementation prerequisite; no new per-service broker users are introduced.
