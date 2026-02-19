# SOA Repository Remediation Plan (Updated)

**Generated:** 2026-01-31
**Updated:** 2026-01-31 (Excluded: trpc-api, trpc-codegen, web-client)
**Current Health:** 2.8/5.0 (Fair) ⚠️
**Target Health:** 4.3/5.0 (Good) ✅
**Estimated Total Effort:** ~12-14 hours over 2 sprints

---

## Scope Exclusions

**Excluded from remediation** (future migrations/refactors):
- ❌ **trpc-api** - Moving to static router (no codegen)
- ❌ **trpc-codegen** - Being deprecated in favor of static router approach
- ❌ **web-client** - Migrating to SvelteKit immediately

**In Scope:** 20 packages (down from 23)
- 3 apps/node: gql-api, rest-api, tgql-api
- 1 app/web: docs
- 11 packages/node
- 5 packages/core

---

## Executive Summary

The SOA repository audit revealed **three critical issues** requiring immediate attention:
1. **Prettier installed** (banned package) in gql-api, rest-api, tgql-api
2. **Zero project-level documentation** (0/20 in-scope packages have CLAUDE.md)
3. **Testing gaps** in gql-api and several other packages

**Good News:**
- ✅ Perfect ESM compliance across all packages
- ✅ Zero runtime tier violations
- ✅ Excellent root and tier-level documentation
- ✅ Config packages (eslint-config, typescript-config) are exemplary

**Path to 4.3/5.0:** Two phases with clear priorities and measurable impact.

---

## Phase 1: Critical Issues (Immediate)

**Goal:** Eliminate critical violations
**Effort:** 2-3 hours
**Impact:** 2.8 → 3.1 (+0.3 points)

### 1.1 Remove Prettier (CRITICAL) ⚠️

**Why:** Prettier is explicitly banned in SOA CLAUDE.md. ESLint-only formatting policy.

**Affected Packages:** 3 apps/node packages
- gql-api
- rest-api
- tgql-api

**Steps:**
```bash
# For each app
cd apps/node/gql-api
pnpm remove prettier
rm -f .prettierrc .prettierignore .prettierrc.json
# Repeat for rest-api and tgql-api
```

**Verification:**
```bash
# Ensure Prettier is gone from in-scope packages
grep "prettier" apps/node/gql-api/package.json
grep "prettier" apps/node/rest-api/package.json
grep "prettier" apps/node/tgql-api/package.json
# All should return nothing
```

**Impact:**
- gql-api: 2.0 → 2.3 (+0.3)
- rest-api: 2.5 → 2.8 (+0.3)
- tgql-api: 3.0 → 3.3 (+0.3)
- **Total:** +0.9 points

### 1.2 Add Tests to gql-api (HIGH PRIORITY) ❌

**Why:** Backend API with 0% test coverage is a critical gap.

**Current State:**
- No test files
- No vitest.config.ts
- Testing dimension: 1/5

**Target:** 40-60% coverage with core functionality tests

**Steps:**

1. **Create vitest.config.ts**
2. **Add test dependencies:** vitest, @vitest/coverage-v8
3. **Create test structure:** test/resolvers, test/services
4. **Write initial tests** for 2-3 key resolvers and services

**Effort:** 2 hours
**Impact:** gql-api: 2.3 → 3.0 (+0.7)

---

## Phase 2: Documentation & Testing (Sprint 1)

**Goal:** Establish documentation and improve test coverage
**Effort:** 10-12 hours
**Impact:** 3.1 → 4.3 (+1.2 points)

### 2.1 Create CLAUDE.md for In-Scope Apps

**Required Apps:** 4 total
- apps/node: gql-api, rest-api, tgql-api
- apps/web: docs

**Template Sections:**
1. Title and tagline
2. Responsibilities
3. Parent Context
4. Tech Stack
5. Key Commands
6. Architecture
7. Convention Deviations (⚠️ if any)
8. See Also

**Effort per app:** 30-45 minutes
**Total effort:** 2-3 hours
**Impact:** +4.0 points (1 point per app)

### 2.2 Create CLAUDE.md for Complex Packages

**Target Packages:** 3 complex packages
- packages/node/api-core (shared API utilities)
- packages/node/db (MongoDB client)
- packages/web/ui (React component library)

**Why These Need Docs:**
- **api-core**: Custom middleware, auth patterns, shared controllers
- **db**: MongoDB connection pooling, schema validation
- **ui**: Component library with design system

**Effort per package:** 45-60 minutes
**Total effort:** 2-3 hours
**Impact:** +1.5 points

### 2.3 Update Tier CLAUDE.md for Simple Packages

**Files to Update:**
- `/packages/core/CLAUDE.md` - Add descriptions for config, tgql-codegen (simple CLI)
- `/packages/node/CLAUDE.md` - Add descriptions for logger, pubsub, redis

**Example:**
```markdown
## Packages

### config
Pure configuration loader with environment variable validation. Single-purpose, zero deviations.
**Usage:** `import { getConfig } from '@saga-ed/soa-config'`

### logger
Simple Pino logger wrapper with sensible defaults. Standard Node.js logging patterns.
**Usage:** `import { logger } from '@saga-ed/soa-logger'`
```

**Effort:** 1 hour
**Impact:** +0.5 points

### 2.4 Expand Test Coverage

**Target Packages:**
- rest-api (15% → 70%)
- tgql-api (30% → 70%)
- 5 untested packages (pubsub-client, pubsub-server, rabbitmq, redis-core, aws-util) → 60%

**Strategy:**
- Focus on public API methods
- Mock external dependencies
- Test critical paths first

**Effort:** 6-8 hours
**Impact:** +2.0 points

---

## Projected Repository Health

| Phase | Timeline | Health Score | Status |
|-------|----------|--------------|--------|
| **Current** | Today | 2.8/5.0 | Fair ⚠️ |
| **Phase 1 Complete** | Day 1 | 3.1/5.0 | Fair ⚠️ |
| **Phase 2 Complete** | Week 2 | 4.3/5.0 | Good ✅ |
| **Maintenance** | Ongoing | 4.3-4.5 | Good ✅ |

---

## Dimension-Specific Improvements

### Runtime Tier Isolation: 5/5 ✅
**No action needed**

### ESM Compliance: 5/5 ✅
**No action needed**

### Testing Requirements: 2.4/5 → 4.0/5
- After Phase 1: 2.6/5
- After Phase 2: 4.0/5

### Documentation Completeness: 1.8/5 → 4.2/5
- After Phase 1: 1.8/5
- After Phase 2: 4.2/5

### Dependency Compliance: 4.2/5 → 5.0/5
- After Phase 1: 5.0/5 (Prettier removed)

### Build Configuration: 4.5/5 → 4.8/5
- After Phase 1: 4.8/5 (vitest configs added)

---

## Execution Plan

### Immediate Actions (Phase 1)

1. ✅ Remove Prettier from gql-api, rest-api, tgql-api
2. ✅ Add vitest config and dependencies to gql-api
3. ✅ Write initial tests for gql-api (2-3 resolvers + services)
4. ✅ Verify all changes

### Week 1-2 Actions (Phase 2)

5. ✅ Create CLAUDE.md for gql-api, rest-api, tgql-api, docs
6. ✅ Create CLAUDE.md for api-core, db, ui
7. ✅ Update tier CLAUDE.md with simple package descriptions
8. ✅ Expand test coverage in rest-api and tgql-api
9. ✅ Add tests to untested packages

---

## Success Metrics

**Quantitative:**
- Repository health: 2.8 → 4.3 (+1.5 points)
- Packages with CLAUDE.md: 0 → 10 (all critical packages)
- Packages with tests: 12 → 18 (90% of in-scope packages)
- Average test coverage: ~35% → ~65%

**Qualitative:**
- Faster onboarding with clear documentation
- Higher confidence in refactoring with test coverage
- No banned packages (Prettier removed)
- Better compliance tracking

---

## Notes on Excluded Packages

### trpc-api + trpc-codegen
**Reason:** Moving to static router approach (no codegen)
**Action:** These will be refactored separately, no remediation needed
**Future:** Once refactored to static router, add documentation and tests

### web-client
**Reason:** Migrating to SvelteKit immediately
**Action:** Focus effort on SvelteKit migration, not remediation
**Future:** New SvelteKit app will start with proper docs and tests

---

**Generated by:** claude-audit skill
**Audit Report:** [soa-audit.md](./soa-audit.md)
**Skill Documentation:** [docs/claude-audit.md](./docs/claude-audit.md)
