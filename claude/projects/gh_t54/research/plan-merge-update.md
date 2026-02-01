# Cross-Repository Update Plan: gh_t54 → main

## Overview

Merge SOA infrastructure changes from `gh_t54` to `main`, publish packages to `saga_js` CodeArtifact, then bring coach, thrive, and nimbee up to date. Phased approach with verification gates between each phase.

---

## Phase 1: SOA — Merge & Publish

### 1.1 Squash Merge gh_t54 → main

**Repo:** `/home/skelly/dev/soa` (487 files changed)

```bash
cd /home/skelly/dev/soa
git checkout main
git pull origin main
git merge --squash gh_t54
git commit -m "Infrastructure modernization: unified saga_js registry, hierarchical CLAUDE.md, ARES testing framework, package restructuring (node/core/web tiers), cross-repo linking"
```

### 1.2 Build & Test SOA on main

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck
```

**Gate:** All builds and tests must pass before proceeding.

### 1.3 Publish to saga_js CodeArtifact

```bash
pnpm soa:auth   # Authenticate with CodeArtifact
# Run publish workflow (actual publish, not dry-run)
```

Use the `.github/workflows/publish-codeartifact.yml` workflow or equivalent local publish commands for all publishable packages.

**Gate:** All packages successfully published. Verify with:
```bash
aws codeartifact list-package-versions --domain saga --repository saga_js --format npm --namespace saga-ed
```

---

## Phase 2: Coach — Fresh PR from main (with test reorganization)

**Repo:** `/home/skelly/dev/coach` (126 files changed on gh_t54, net -10k lines)

Prioritized early — this repo is shared with other developers who need the updated infrastructure promptly.

### 2.1 Create Fresh Branch & Apply Changes

```bash
cd /home/skelly/dev/coach
git checkout main
git pull origin main
git checkout -b update/soa-infrastructure
git merge --squash gh_t54
git commit -m "SOA infrastructure alignment: app/package restructuring, saga_js registry, cross-repo linking"
```

### 2.2 Reorganize Tests per ARES/Testing Policies

Apply testing conventions from `~/dev/soa/claude/testing/`:
- Rename test files to follow `name.[type].[purpose?].test.ts` convention
  - e.g., `example.test.ts` → `example.unit.test.ts`
- Ensure tests are in `__tests__/` directories adjacent to source
- **Do NOT fix failing tests** — only reorganize file structure
- Document known failures in a tracking issue

**Key testing policy references:**
- `~/dev/soa/claude/testing/conventions.md` — file naming & structure
- `~/dev/soa/claude/testing/philosophy.md` — ARES framework
- `~/dev/soa/claude/testing/builders.md` — test data patterns

### 2.3 Build & Test (link:off)

```bash
pnpm soa:link:off
pnpm install
pnpm build
pnpm test          # Known failures expected — document them
pnpm typecheck
```

### 2.4 Build & Test (link:on)

```bash
pnpm soa:link:on
pnpm install
pnpm build
pnpm test
```

### 2.5 Push & Create PR

```bash
pnpm soa:link:off
git push -u origin update/soa-infrastructure
gh pr create --title "SOA infrastructure alignment" --body "..."
```

**Gate:** Build passes in both link states. Known test failures documented. PR created for developer review.

**Key files:**
- `soa-link.json` — 4 packages: api-core, config, db, logger
- `.npmrc` — points to saga_js
- `pnpm-workspace.yaml` — updated workspace paths

---

## Phase 3: Thrive — Fresh PR from main

**Repo:** `/home/skelly/dev/thrive` (78 files changed on gh_t54)

### 3.1 Create Fresh Branch & Apply Changes

```bash
cd /home/skelly/dev/thrive
git checkout main
git pull origin main
git checkout -b update/soa-infrastructure
git merge --squash gh_t54
git commit -m "SOA infrastructure alignment: app/package restructuring, saga_js registry, cross-repo linking"
```

### 3.2 Build & Test (link:off)

```bash
pnpm soa:link:off       # Ensure using published packages
pnpm install
pnpm build
pnpm test
pnpm typecheck
```

**Validates:** Published `@saga-ed/*` packages resolve correctly from `saga_js`.

### 3.3 Build & Test (link:on)

```bash
pnpm soa:link:on        # Switch to local SOA packages
pnpm install
pnpm build
pnpm test
```

**Validates:** Local linking works with the new SOA package structure (node/core/web tiers).

### 3.4 Push & Create PR

```bash
pnpm soa:link:off       # Pre-commit hook requires links off
git push -u origin update/soa-infrastructure
gh pr create --title "SOA infrastructure alignment" --body "..."
```

**Gate:** Both link:on and link:off builds pass. PR created for review.

**Key files:**
- `soa-link.json` — 5 packages: api-core, config, db, logger, rabbitmq
- `.npmrc` — points to saga_js
- `pnpm-workspace.yaml` — updated workspace paths
- `turbo.json` — updated task definitions

---

## Phase 4: Nimbee — Validation Only

**Repo:** `/home/skelly/dev/nimbee` (already up to date on `gh_7763`)

### 4.1 Verify link:off Build

```bash
cd /home/skelly/dev/nimbee
pnpm soa:link:off
pnpm install
# Build/test the relevant JS apps (saga_api, etc.)
```

**Validates:** `@saga-ed/*` and `@nimbee/*` packages resolve from `saga_js` after SOA main update.

### 4.2 Verify link:on Build

```bash
pnpm soa:link:on
pnpm install
# Build/test the relevant JS apps
```

### 4.3 Pre-commit Hook Validation

```bash
pnpm soa:link:on
git add -A && git commit -m "test"  # Should be BLOCKED by check-soa-links.sh
pnpm soa:link:off
```

**Gate:** Both link states build successfully. Pre-commit hook correctly blocks link:on commits.

---

## Phase Summary

| Phase | Repo | Branch | Action | Key Verification |
|-------|------|--------|--------|------------------|
| 1 | soa | main ← gh_t54 | Squash merge + publish | Build, test, publish to saga_js |
| 2 | coach | update/soa-infrastructure | Fresh PR + test reorg | Link on/off build, test reorg |
| 3 | thrive | update/soa-infrastructure | Fresh PR from main | Link on/off build+test |
| 4 | nimbee | gh_7763 | Validation only | Link on/off build+test |

## Execution Order Rationale

1. **SOA first** — all other repos depend on published packages
2. **Coach second** — shared with other developers who need the updated infrastructure promptly; PR created early so team can begin review
3. **Thrive third** — simpler scope (no test reorganization), can proceed independently
4. **Nimbee last** — already up to date, just needs validation after SOA packages are published

## Risk Mitigation

- **Failed SOA publish:** Fix and re-publish before proceeding to consumer repos
- **Coach test failures:** Document in tracking issue; the reorganization-only approach keeps scope manageable
- **Link:off resolution failures:** Indicates packages weren't published correctly — go back to Phase 1.3
- **Nimbee build failures:** May indicate `@nimbee/*` packages also need republishing to saga_js
