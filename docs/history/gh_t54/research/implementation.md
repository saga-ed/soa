# Implementation Plan: Hierarchical CLAUDE.md for SOA, Thrive, Coach

Based on the research in [plan.md](./plan.md), this document provides a phased implementation approach.

---

## Overview

**Goal**: Implement hierarchical CLAUDE.md documentation across three repos with:
- Consistent `apps/web/`, `apps/node/`, `apps/core/` structure
- Consistent `packages/web/`, `packages/node/`, `packages/core/` structure
- Shared Claude context in `claude/` directory (visible, not hidden)
- Human documentation in `docs/` directory
- Cross-repo references from thrive/coach to soa

**Framework Strategy**:
- SOA: Next.js (legacy)
- Thrive: Svelte/SvelteKit (primary)
- Coach: Svelte/SvelteKit (primary)

**CLAUDE.md File Strategy**:
- **SOA**: Overwrite existing CLAUDE.md files directly
- **Thrive/Coach**: Rename existing CLAUDE.md files to `CLAUDE.pre-gh_t54.md` before creating new ones

---

## Baseline Verification Protocol

**CRITICAL**: Before starting implementation and after each phase, verify build and tests pass in all three repos.

### Pre-Implementation Baseline

Before starting any phase, establish baseline:

```bash
# SOA baseline
cd ~/dev/soa
pnpm install
pnpm build
pnpm test

# Thrive baseline
cd ~/dev/thrive
pnpm install
pnpm build
pnpm test

# Coach baseline
cd ~/dev/coach
pnpm install
pnpm build
pnpm test
```

Record any pre-existing failures to distinguish from changes introduced by this work.

### Post-Phase Verification

After completing each phase, run the same verification:

```bash
# Verify all repos still build and test
cd ~/dev/soa && pnpm install && pnpm build && pnpm test
cd ~/dev/thrive && pnpm install && pnpm build && pnpm test
cd ~/dev/coach && pnpm install && pnpm build && pnpm test
```

**If verification fails**:
1. Identify the misconfiguration
2. Fix before proceeding to next phase
3. Document fix in phase notes

---

## Cross-Repo Workspace Considerations

**IMPORTANT**: Thrive and coach repos link to SOA packages via pnpm workspace protocol or file references. When SOA packages move to new paths, these repos will need updates.

### Package Reference Patterns to Watch

```yaml
# Example: thrive/package.json or thrive/apps/*/package.json
dependencies:
  "@saga-ed/soa-config": "workspace:*"      # If using workspace protocol
  "@saga-ed/soa-db": "file:../../soa/packages/db"  # If using file reference
```

### After SOA Package Moves (Phase 3)

1. **Check thrive** for any file-based references to old paths
2. **Check coach** for any file-based references to old paths
3. Update `pnpm-workspace.yaml` in thrive/coach if they reference soa packages
4. Run `pnpm install` in all repos to re-link

---

## Phase 1: SOA Claude Infrastructure (Foundation)

**Priority**: High - enables all other phases
**Estimated Scope**: Create directories and base documentation

### 1.1 Create `claude/` Directory Structure

```bash
# From soa root
mkdir -p claude/frontend/{nextjs,sveltekit,shared}
mkdir -p claude/skills/documentation-system/{guides,templates,scripts}
mkdir -p claude/commands
```

### 1.2 Create Frontend Framework Documentation

| File | Description |
|------|-------------|
| `claude/frontend/README.md` | Framework choice guidance, links to subdirs |
| `claude/frontend/nextjs/getting-started.md` | Legacy Next.js patterns (SOA only) |
| `claude/frontend/sveltekit/getting-started.md` | Primary SvelteKit patterns (thrive/coach) |
| `claude/frontend/shared/api-client-patterns.md` | Framework-agnostic API patterns |
| `claude/frontend/shared/auth-integration.md` | Auth patterns for web apps |

### 1.3 Create Documentation System Skill

| File | Description |
|------|-------------|
| `claude/skills/documentation-system/SKILL.md` | Main skill documentation |
| `claude/skills/documentation-system/templates/claude-md-root.md` | Root CLAUDE.md template |
| `claude/skills/documentation-system/templates/claude-md-tier-web.md` | Web tier template |
| `claude/skills/documentation-system/templates/claude-md-tier-node.md` | Node tier template |
| `claude/skills/documentation-system/templates/claude-md-tier-core.md` | Core tier template |
| `claude/skills/documentation-system/scripts/validate_tokens.sh` | Token budget validation |

### 1.4 Deliverables Checklist

- [ ] `claude/frontend/README.md` created
- [ ] `claude/frontend/nextjs/getting-started.md` created
- [ ] `claude/frontend/sveltekit/getting-started.md` created
- [ ] `claude/frontend/shared/api-client-patterns.md` created
- [ ] `claude/skills/documentation-system/SKILL.md` created
- [ ] Templates created in `claude/skills/documentation-system/templates/`

---

## Phase 2: SOA Apps Reorganization

**Priority**: High - restructures apps by runtime
**Dependencies**: None (can run in parallel with Phase 1)

### 2.1 Create Runtime Tier Directories

```bash
# From soa root
mkdir -p apps/web
mkdir -p apps/node
mkdir -p apps/core
```

### 2.2 Move Apps to Runtime Tiers

| Current Location | New Location |
|------------------|--------------|
| `apps/docs` | `apps/web/docs/` |
| `apps/examples/web-client` | `apps/web/web-client/` |
| `apps/examples/trpc-api` | `apps/node/trpc-api/` |
| `apps/examples/rest-api` | `apps/node/rest-api/` |
| `apps/examples/gql-api` | `apps/node/gql-api/` |
| `apps/examples/tgql-api` | `apps/node/tgql-api/` |

### 2.3 Update Workspace Configuration

Update `pnpm-workspace.yaml`:
```yaml
packages:
  - 'apps/web/*'
  - 'apps/node/*'
  - 'apps/core/*'
  - 'packages/web/*'
  - 'packages/node/*'
  - 'packages/core/*'
```

Update `turbo.json` if needed for new paths.

### 2.4 Create Tier CLAUDE.md Files

| File | Content Focus |
|------|---------------|
| `apps/CLAUDE.md` | Category overview, links to tiers |
| `apps/web/CLAUDE.md` | Web runtime, refs `claude/frontend/` |
| `apps/node/CLAUDE.md` | Node runtime, Docker/ECS patterns |
| `apps/core/CLAUDE.md` | Runtime-agnostic apps (if any) |

### 2.5 Deliverables Checklist

- [ ] Apps moved to `apps/web/` and `apps/node/`
- [ ] `apps/examples/` directory removed
- [ ] `pnpm-workspace.yaml` updated
- [ ] `turbo.json` updated (if needed)
- [ ] `apps/CLAUDE.md` created
- [ ] `apps/web/CLAUDE.md` created
- [ ] `apps/node/CLAUDE.md` created
- [ ] `pnpm install` succeeds
- [ ] `pnpm build` succeeds

---

## Phase 3: SOA Packages Reorganization

**Priority**: Medium - larger scope, more impact
**Dependencies**: Phase 2 completed (to validate pattern)

### 3.1 Create Runtime Tier Directories

```bash
# From soa root
mkdir -p packages/web
mkdir -p packages/node
mkdir -p packages/core
```

### 3.2 Move Packages to Runtime Tiers

**Web Runtime (Browser)**:
| Current | New |
|---------|-----|
| `packages/ui` | `packages/web/ui/` |

**Node Runtime (Server)**:
| Current | New |
|---------|-----|
| `packages/api-core` | `packages/node/api-core/` |
| `packages/api-util` | `packages/node/api-util/` |
| `packages/db` | `packages/node/db/` |
| `packages/logger` | `packages/node/logger/` |
| `packages/pubsub-client` | `packages/node/pubsub-client/` |
| `packages/pubsub-core` | `packages/node/pubsub-core/` |
| `packages/pubsub-server` | `packages/node/pubsub-server/` |
| `packages/rabbitmq` | `packages/node/rabbitmq/` |
| `packages/redis-core` | `packages/node/redis-core/` |
| `packages/aws-util` | `packages/node/aws-util/` |
| `packages/test-util` | `packages/node/test-util/` |

**Core Runtime (Agnostic)**:
| Current | New |
|---------|-----|
| `packages/config` | `packages/core/config/` |
| `packages/trpc-codegen` | `packages/core/trpc-codegen/` |
| `packages/tgql-codegen` | `packages/core/tgql-codegen/` |
| `packages/typescript-config` | `packages/core/typescript-config/` |
| `packages/eslint-config` | `packages/core/eslint-config/` |

### 3.3 Update Import Paths

After moving packages, update all imports in:
- `apps/web/*` - update imports
- `apps/node/*` - update imports
- Other packages with cross-dependencies

### 3.4 Create Tier CLAUDE.md Files

| File | Content Focus |
|------|---------------|
| `packages/CLAUDE.md` | Category overview, runtime guidance |
| `packages/web/CLAUDE.md` | Browser runtime constraints |
| `packages/node/CLAUDE.md` | Node.js patterns, server-side |
| `packages/core/CLAUDE.md` | Runtime-agnostic, ESM patterns |

### 3.5 Deliverables Checklist

- [ ] Packages moved to `packages/{web,node,core}/`
- [ ] Import paths updated across codebase
- [ ] `pnpm-workspace.yaml` verified
- [ ] `packages/CLAUDE.md` created
- [ ] `packages/web/CLAUDE.md` created
- [ ] `packages/node/CLAUDE.md` created
- [ ] `packages/core/CLAUDE.md` created
- [ ] `pnpm install` succeeds
- [ ] `pnpm build` succeeds
- [ ] `pnpm test` succeeds

---

## Phase 4: SOA Root CLAUDE.md Refactor

**Priority**: Medium
**Dependencies**: Phases 1-3 completed

### 4.1 Refactor Root CLAUDE.md

Update `/CLAUDE.md` to follow template:
- Keep under 500 tokens (~375 words)
- Include: title, responsibilities, tech stack
- Link to `claude/` for detailed context
- Link to `docs/` for human documentation
- Mark deviations with ⚠️

### 4.2 Create Project-Level CLAUDE.md Files

For each app and package, create CLAUDE.md with:
- Project responsibilities
- Key patterns and conventions
- Links to parent tier docs

### 4.3 Deliverables Checklist

- [ ] Root `/CLAUDE.md` refactored (< 500 tokens)
- [ ] `apps/web/docs/CLAUDE.md` created
- [ ] `apps/web/web-client/CLAUDE.md` created
- [ ] `apps/node/trpc-api/CLAUDE.md` created
- [ ] `apps/node/rest-api/CLAUDE.md` created
- [ ] Key packages have CLAUDE.md files

---

## Phase 5: Cross-Repo Setup (Thrive)

**Priority**: Medium
**Dependencies**: Phase 1 completed (frontend docs exist), Phase 3 completed (packages moved)

### 5.1 Rename Existing CLAUDE.md Files

**IMPORTANT**: Do NOT overwrite existing CLAUDE.md files in thrive. Rename them first.

```bash
# From thrive root
# Find and rename all existing CLAUDE.md files
find . -name "CLAUDE.md" -type f | while read f; do
  mv "$f" "${f%.md}.pre-gh_t54.md"
done
```

This preserves the original documentation for reference while implementing the new structure.

### 5.2 Create Thrive Directory Structure

```bash
# From thrive root
mkdir -p apps/web
mkdir -p apps/node
mkdir -p packages/{web,node,core}
mkdir -p claude
```

### 5.3 Update Thrive Workspace Configuration

If thrive references SOA packages, update paths after SOA Phase 3:

```yaml
# thrive/pnpm-workspace.yaml - check for soa package references
# If using file: protocol, update paths from:
#   "file:../soa/packages/config"
# to:
#   "file:../soa/packages/core/config"
```

Run `pnpm install` after any path updates.

### 5.4 Create Thrive CLAUDE.md Files

| File | Content |
|------|---------|
| `CLAUDE.md` | Root with cross-repo refs to soa |
| `apps/web/CLAUDE.md` | Refs `soa/claude/frontend/sveltekit/` |
| `apps/node/CLAUDE.md` | Refs soa node patterns |

### 5.5 Example: thrive/apps/web/CLAUDE.md

```markdown
# Thrive Web

Svelte/SvelteKit-based frontend for Thrive platform.

## Shared Documentation

See [soa/claude/frontend/sveltekit/](~/dev/soa/claude/frontend/sveltekit/) for:
- Project setup patterns
- Routing conventions
- Load function patterns
- Amplify deployment

## Project-Specific

- Uses PostgreSQL via Prisma (unlike SOA's MongoDB)
- Serena MCP integration in `.serena/`
```

### 5.6 Deliverables Checklist

- [ ] Existing CLAUDE.md files renamed to `.pre-gh_t54.md`
- [ ] Workspace configuration updated for new SOA package paths
- [ ] Thrive `/CLAUDE.md` created
- [ ] `thrive/apps/web/CLAUDE.md` created
- [ ] `thrive/apps/node/CLAUDE.md` created
- [ ] Cross-repo links verified working
- [ ] `pnpm install` succeeds
- [ ] `pnpm build` succeeds
- [ ] `pnpm test` succeeds

---

## Phase 6: Cross-Repo Setup (Coach)

**Priority**: Medium
**Dependencies**: Phase 1 completed, Phase 3 completed (packages moved)

### 6.1 Rename Existing CLAUDE.md Files

**IMPORTANT**: Do NOT overwrite existing CLAUDE.md files in coach. Rename them first.

```bash
# From coach root
# Find and rename all existing CLAUDE.md files
find . -name "CLAUDE.md" -type f | while read f; do
  mv "$f" "${f%.md}.pre-gh_t54.md"
done
```

Known existing file: `/home/skelly/dev/coach/claude/api-poc/CLAUDE.md`

### 6.2 Create Coach Directory Structure

```bash
# From coach root
mkdir -p apps/web
mkdir -p apps/node
mkdir -p packages/{web,node,core}
mkdir -p claude
```

### 6.3 Update Coach Workspace Configuration

If coach references SOA packages, update paths after SOA Phase 3:

```yaml
# coach/pnpm-workspace.yaml - check for soa package references
# If using file: protocol, update paths from:
#   "file:../soa/packages/config"
# to:
#   "file:../soa/packages/core/config"
```

Run `pnpm install` after any path updates.

### 6.4 Create Coach CLAUDE.md Files

| File | Content |
|------|---------|
| `CLAUDE.md` | Root with cross-repo refs to soa |
| `apps/web/CLAUDE.md` | Refs `soa/claude/frontend/sveltekit/` |
| `apps/node/coach-api/CLAUDE.md` | Refs soa node patterns |

### 6.5 Deliverables Checklist

- [ ] Existing CLAUDE.md files renamed to `.pre-gh_t54.md`
- [ ] Workspace configuration updated for new SOA package paths
- [ ] Coach `/CLAUDE.md` created
- [ ] `coach/apps/web/CLAUDE.md` created
- [ ] `coach/apps/node/coach-api/CLAUDE.md` created
- [ ] Cross-repo links verified working
- [ ] `pnpm install` succeeds
- [ ] `pnpm build` succeeds
- [ ] `pnpm test` succeeds

---

## Phase 7: Validation & CI

**Priority**: Low (nice to have)
**Dependencies**: All previous phases

### 7.1 Token Budget Validation

Create `claude/skills/documentation-system/scripts/validate_tokens.sh`:
- Target: ~500 tokens per CLAUDE.md
- Maximum: 1000 tokens
- Report violations

### 7.2 Link Validation

Create `claude/skills/documentation-system/scripts/validate_links.sh`:
- Check all markdown links resolve
- Verify cross-repo paths exist

### 7.3 GitHub Actions Workflow

Create `.github/workflows/validate-documentation.yml`:
- Run token validation on PR
- Run link validation on PR
- Report results

### 7.4 Deliverables Checklist

- [ ] `validate_tokens.sh` created and tested
- [ ] `validate_links.sh` created and tested
- [ ] GitHub Actions workflow created
- [ ] CI passing on all repos

---

## Execution Order Summary

```
BASELINE ──► All repos build/test verified

Phase 1 (SOA Claude Infrastructure) ─────┐
                                         ├──► Phase 4 (Root CLAUDE.md) ──► VERIFY
Phase 2 (SOA Apps Reorg) ──► VERIFY ─────┤
                                         │
Phase 3 (SOA Packages Reorg) ──► VERIFY ─┘
                                    │
                                    ├──► Phase 5 (Thrive Setup) ──► VERIFY
                                    │         └─ Update workspace refs
                                    │         └─ Rename CLAUDE.md files
                                    │
                                    └──► Phase 6 (Coach Setup) ──► VERIFY
                                              └─ Update workspace refs
                                              └─ Rename CLAUDE.md files

Phases 4-6 ──► Phase 7 (Validation & CI)
```

**VERIFY** = Run `pnpm install && pnpm build && pnpm test` in soa, thrive, and coach

**Recommended Start**: Phases 1 and 2 can run in parallel.

**Critical Path**: Phase 3 (SOA Packages Reorg) must complete before Phase 5/6 because thrive/coach may have workspace references to SOA packages that need path updates.

---

## Risk Mitigation

### Breaking Changes from Package Moves (Phase 3)

**Risk**: Moving packages breaks imports across repos
**Mitigation**:
1. Complete Phase 2 first to validate the pattern
2. Update imports in same PR as moves
3. Run full test suite before merging
4. Consider re-exporting from old paths temporarily

### Cross-Repo pnpm Workspace Breakage

**Risk**: Thrive/coach pnpm links to SOA packages break after package moves
**Mitigation**:
1. Document all cross-repo package references before Phase 3
2. Update thrive/coach `pnpm-workspace.yaml` or `package.json` references immediately after SOA moves
3. Run `pnpm install` in all repos after any path changes
4. Verify builds pass before proceeding

**Detection**: Look for these patterns in thrive/coach:
```bash
# Find file-based references to soa packages
grep -r "file:.*soa/packages" ~/dev/thrive ~/dev/coach
# Find workspace references
grep -r "@saga-ed/soa-" ~/dev/thrive ~/dev/coach
```

### Cross-Repo Link Breakage

**Risk**: Links to soa from thrive/coach break
**Mitigation**:
1. Use relative paths where possible
2. Document canonical paths in root CLAUDE.md
3. Run link validation in CI

### Token Budget Overflow

**Risk**: CLAUDE.md files too large
**Mitigation**:
1. Extract details to `claude/` or `docs/`
2. Use progressive disclosure pattern
3. Run validation script before committing

### Loss of Existing Documentation (Thrive/Coach)

**Risk**: Overwriting existing CLAUDE.md files loses valuable context
**Mitigation**:
1. Rename existing files to `.pre-gh_t54.md` suffix before creating new ones
2. Review renamed files when creating new CLAUDE.md to incorporate relevant content
3. Keep `.pre-gh_t54.md` files until new documentation is validated

---

## Success Criteria

1. **Structure**: All three repos follow `apps/{web,node,core}` and `packages/{web,node,core}` pattern
2. **Documentation**: Every tier has a CLAUDE.md file
3. **Cross-Repo**: Thrive and coach successfully reference soa documentation
4. **Token Budget**: All CLAUDE.md files under 500 tokens (target)
5. **Build**: `pnpm build` succeeds in all repos after reorganization
6. **Tests**: `pnpm test` passes in all repos
7. **Preservation**: All original CLAUDE.md files in thrive/coach renamed to `.pre-gh_t54.md`
8. **Workspace Links**: All pnpm workspace references updated for new package paths
9. **Baseline Maintained**: No regressions from pre-implementation baseline in any repo
