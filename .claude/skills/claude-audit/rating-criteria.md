# Rating Criteria

This document defines the 5-point scale for each of the six audit dimensions.

## Overall Rating Scale

- ✅ **5.0 - Excellent**: Fully compliant with all documented standards
- ✅ **4.0-4.5 - Good**: Minor issues only, easily fixed
- ⚠️ **3.0-3.5 - Fair**: Moderate compliance gaps requiring attention
- ❌ **2.0-2.5 - Poor**: Significant compliance issues needing immediate work
- ❌ **1.0-1.5 - Critical**: Major violations, architectural problems

## Dimension 1: Runtime Tier Isolation

Ensures correct separation between node/web/core packages.

### 5 Points - Excellent ✅
- Zero violations detected
- Package correctly placed in appropriate tier (node/web/core)
- All imports respect runtime boundaries
- No forbidden APIs used

### 4 Points - Good ✅
- 1-2 minor violations (e.g., single incorrect import that doesn't break functionality)
- Package correctly placed in tier
- Violations are isolated and easily fixed

**Example:** A packages/node/* package has one import from a web package in a test file.

### 3 Points - Fair ⚠️
- 3-5 violations detected
- Multiple incorrect imports across different files
- Violations show pattern of misunderstanding tier boundaries

**Example:** A packages/node/* package has several imports of browser APIs scattered across source files.

### 2 Points - Poor ❌
- 6+ violations detected
- Widespread incorrect imports
- Pattern shows fundamental misunderstanding of architecture

**Example:** A packages/node/* package extensively uses window, document, and DOM APIs.

### 1 Point - Critical ❌
- Critical architectural violation
- Package in wrong tier entirely
- Core functionality depends on forbidden runtime

**Example:** A packages/core/* package directly imports Node.js fs module, or a packages/web/* package establishes database connections.

---

## Dimension 2: ESM Compliance

Ensures strict ESM patterns as documented in /soa/claude/esm.md.

### 5 Points - Excellent ✅
- All imports include .js extensions
- package.json has "type": "module"
- No require() usage anywhere
- __dirname follows fileURLToPath pattern (if needed)
- Top-level await used correctly (if needed)

**Example:**
```typescript
import { db } from './db.js';
import { logger } from '@saga-ed/soa-logger/index.js';
```

### 4 Points - Good ✅
- 1-3 imports missing .js extensions
- All other ESM patterns correct
- No CommonJS usage

**Example:**
```typescript
import { db } from './db';  // ❌ Missing .js
import { logger } from '@saga-ed/soa-logger/index.js';  // ✅ Correct
```

### 3 Points - Fair ⚠️
- 4-10 imports missing .js extensions, OR
- 1 incorrect __dirname pattern (old style), OR
- Minor ESM violations

**Example:** Multiple files with missing .js extensions, but no CommonJS usage.

### 2 Points - Poor ❌
- CommonJS require() found in source code, OR
- package.json missing "type": "module", OR
- 10+ missing .js extensions

**Example:**
```javascript
const db = require('./db');  // ❌ CommonJS in ESM project
```

### 1 Point - Critical ❌
- Mixed module systems (both ESM and CommonJS)
- Critical ESM violations preventing proper module resolution
- Multiple fundamental ESM violations

**Example:** Package uses both require() and import, has no "type": "module", and has 20+ missing .js extensions.

---

## Dimension 3: Testing Requirements

Ensures adequate test coverage and correct testing patterns.

### 5 Points - Excellent ✅
- Complete test coverage meeting requirements
- Backend APIs have comprehensive Vitest tests
- Service files have 100% coverage (Thrive) or high coverage (SOA/Coach)
- Tests follow AAA pattern
- Static imports for controllers (not dynamic)
- Database isolation via VITEST_POOL_ID (for parallel tests)
- Tests run successfully

**Example:** All service files have test files, coverage >95%, tests use proper patterns.

### 4 Points - Good ✅
- Tests exist for most code
- Coverage slightly below target (90-94%)
- Tests follow correct patterns
- Minor gaps in edge case testing

**Example:** Service files have tests, coverage is 92%, one service missing a few edge case tests.

### 3 Points - Fair ⚠️
- Tests exist but incomplete
- Coverage 60-89%
- Missing tests for key scenarios
- Some tests don't follow documented patterns

**Example:** Only half of service files have tests, coverage is 70%, some tests use dynamic imports instead of static.

### 2 Points - Poor ❌
- Minimal testing
- Coverage <60%
- Tests exist but don't cover core functionality
- Tests don't follow documented patterns

**Example:** Only 2-3 basic tests exist, coverage is 30%, tests don't use AAA pattern.

### 1 Point - Critical ❌
- No tests at all, OR
- Tests exist but don't run (broken), OR
- Tests exist but have zero coverage (not actually testing anything)

**Example:** No test files found, or test files exist but fail to run due to configuration issues.

---

## Dimension 4: Documentation Completeness

Ensures appropriate documentation exists for packages based on their complexity and deviation from tier-level patterns.

### When CLAUDE.md is Required

A package SHOULD have its own CLAUDE.md when it:
- **Deviates from tier conventions** (requires ⚠️ Convention Deviations section)
- **Has complex responsibilities** that aren't obvious from package name
- **Has unique tech stack** beyond tier-level defaults
- **Has non-obvious usage patterns** or special requirements
- **Is large/complex** with sub-components or sectors
- **Has special constraints** (e.g., 100% coverage requirement, specific dependencies)

### When CLAUDE.md is Optional

A package MAY skip CLAUDE.md when it:
- **Perfectly follows tier patterns** with zero deviations
- **Is simple/single-purpose** (e.g., pure types package, simple utility)
- **Has no unique conventions** beyond tier-level documentation
- **Is self-documenting** with clear code and standard patterns
- **Listed in tier CLAUDE.md** with adequate description

### 5 Points - Excellent ✅

**Path A: Has Complete CLAUDE.md**
- CLAUDE.md exists with all required sections:
  - Title and tagline
  - Responsibilities
  - Parent Context (link to parent CLAUDE.md)
  - Tech Stack
  - Key Commands
  - Convention Deviations (if any, marked with ⚠️)
  - See Also (links to detailed docs)
- Token budget compliant (~500 tokens, max 1000)
- "See" directives point to real files
- Bidirectional references work (parent ↔ child)

**Path B: Simple Package, No CLAUDE.md Needed**
- Package is simple/single-purpose (types-only, basic utility, etc.)
- Zero deviations from tier-level patterns
- Package well-described in tier-level CLAUDE.md
- No unique tech stack or conventions
- Code is self-documenting

**Example A:** Complete CLAUDE.md with all sections, 450 tokens, all links valid.
**Example B:** `@saga-ed/soa-config` - Simple config loader, follows all tier patterns, well-described in `/packages/core/CLAUDE.md`.

### 4 Points - Good ✅
- CLAUDE.md exists with 1-2 minor sections missing (e.g., Convention Deviations when none exist)
- Token budget compliant
- All critical sections present
- OR: Simple package with minor deviation noted in tier-level docs

**Example:** CLAUDE.md exists with all critical sections, missing only "Convention Deviations" which is optional if there are no deviations.

### 3 Points - Fair ⚠️

**Scenario A: Incomplete Documentation**
- CLAUDE.md exists but incomplete (3-4 sections missing)
- Token budget exceeded (>1000 tokens), OR
- Multiple broken "See" directives

**Scenario B: Missing Documentation for Complex Package**
- No CLAUDE.md but package has moderate complexity OR deviations
- Package should have docs but doesn't
- Not adequately described in tier-level docs

**Example A:** CLAUDE.md exists but missing Tech Stack, Key Commands, and See Also sections. 1200 tokens.
**Example B:** Complex package with unique patterns but no CLAUDE.md and only brief mention in tier docs.

### 2 Points - Poor ❌
- CLAUDE.md severely incomplete (>50% missing)
- Most sections missing or stub-only
- No links to parent/child docs
- OR: Complex package with significant deviations but no CLAUDE.md at all

**Example:** CLAUDE.md has only a title and one paragraph description, or complex package with custom patterns completely undocumented.

### 1 Point - Critical ❌
- Critical/complex package with NO documentation
- Package has major deviations from tier patterns but no CLAUDE.md
- Package has unique tech stack/conventions but completely undocumented
- OR: CLAUDE.md required but missing AND package not mentioned in tier docs

**Example:** Backend API with custom architecture, unique dependencies, and non-standard patterns but zero documentation.

---

## Dimension 5: Dependency Compliance

Ensures correct dependency versions, pnpm usage, and workspace configuration.

### 5 Points - Excellent ✅
- All dependencies correct and properly versioned
- Coach/Thrive: @saga-ed/soa-* versions exactly match SOA
- pnpm-lock.yaml exists (no package-lock.json or yarn.lock)
- Workspace configuration correct
- No banned packages (e.g., Prettier)
- Dependencies listed in correct section (dependencies vs devDependencies)

**Example:** All @saga-ed/soa-* versions match SOA exactly, using pnpm, no banned packages.

### 4 Points - Good ✅
- Minor version mismatches (patch level only)
- All other dependency rules followed
- pnpm used correctly

**Example:** @saga-ed/soa-db is 1.2.3 in coach but 1.2.0 in soa (patch mismatch only).

### 3 Points - Fair ⚠️
- Moderate version mismatches (minor level)
- Some dependencies in wrong section
- Workspace config incomplete

**Example:** @saga-ed/soa-db is 1.3.0 in coach but 1.2.0 in soa (minor mismatch).

### 2 Points - Poor ❌
- Major version mismatches
- Incorrect dependencies listed
- Missing critical dependencies
- Dependencies not following workspace protocol

**Example:** @saga-ed/soa-db is 2.0.0 in coach but 1.2.0 in soa (major mismatch).

### 1 Point - Critical ❌
- Wrong package manager used (npm or yarn instead of pnpm)
- Banned packages found (Prettier)
- Missing critical dependencies that break functionality
- No package.json at all

**Example:** yarn.lock file exists, or Prettier is installed despite being banned.

---

## Dimension 6: Build Configuration

Ensures correct build tooling configuration.

### 5 Points - Excellent ✅
- turbo.json exists and correctly configured
- tsconfig.json exists with correct inheritance
- vitest.config.ts exists (if tests present)
- package.json scripts follow conventions
- All build tasks defined (build, test, lint, dev)
- Build runs successfully

**Example:** Complete build configuration with turbo.json, tsconfig extends @saga-ed/soa-typescript-config, vitest.config.ts present, all scripts defined.

### 4 Points - Good ✅
- Build configuration mostly complete
- Minor issues (missing optional scripts like "clean")
- Build runs successfully
- All critical configs present

**Example:** turbo.json and tsconfig correct, but missing "clean" script in package.json.

### 3 Points - Fair ⚠️
- Moderate configuration issues
- tsconfig.json doesn't extend shared config correctly
- Some build tasks missing from turbo.json
- Build runs but with warnings

**Example:** tsconfig.json exists but doesn't extend shared config, turbo.json missing "lint" task.

### 2 Points - Poor ❌
- Significant configuration missing
- turbo.json missing critical tasks
- tsconfig.json severely misconfigured
- Build fails or produces errors

**Example:** turbo.json missing "test" task, tsconfig has incorrect compiler options.

### 1 Point - Critical ❌
- No build configuration at all
- turbo.json doesn't exist
- No tsconfig.json
- Build completely broken

**Example:** No turbo.json, no tsconfig.json, build fails immediately.

---

## Composite Score Calculation

The overall package score is calculated as:

```
Composite Score = ROUND_TO_HALF(
  (Runtime + ESM + Testing + Docs + Deps + Build) / 6
)
```

**Example:**
- Runtime Tier Isolation: 5
- ESM Compliance: 4
- Testing Requirements: 5
- Documentation Completeness: 4
- Dependency Compliance: 5
- Build Configuration: 5

Composite = (5 + 4 + 5 + 4 + 5 + 5) / 6 = 28/6 = 4.67 → **4.5** (rounded to nearest 0.5)

**Rating:** ✅ 4.5/5.0 - Good

---

## Repository Health Score

The overall repository health is calculated as:

```
Repo Health = ROUND_TO_TENTH(
  AVERAGE(all package composite scores)
)
```

**Example:**
- gql-api: 5.0
- trpc-api: 4.5
- rest-api: 3.5
- db: 5.0
- logger: 4.0

Repo Health = (5.0 + 4.5 + 3.5 + 5.0 + 4.0) / 5 = 22/5 = 4.4

**Rating:** ✅ 4.4/5.0 - Good

---

## Interpretation Guide

### Excellent (5.0)
**Action:** No immediate action required. Maintain current standards.

### Good (4.0-4.5)
**Action:** Fix minor issues in next iteration. Not urgent but should be addressed.

### Fair (3.0-3.5)
**Action:** Schedule remediation work soon. Moderate priority.

### Poor (2.0-2.5)
**Action:** Address immediately. High priority. May affect code quality or team velocity.

### Critical (1.0-1.5)
**Action:** Drop everything and fix. Blocking issue. May cause runtime errors or architectural problems.

---

## Special Cases

### New Packages (< 1 week old)
- Documentation: Minimum 3/5 expected (basic CLAUDE.md)
- Testing: Minimum 2/5 acceptable (some tests)
- Other dimensions: Full compliance expected (5/5)

### Legacy Packages (marked as such in CLAUDE.md)
- May have lower testing requirements (minimum 2/5)
- Must still meet ESM, Runtime Tier, and Build requirements (4/5+)
- Documentation still required (minimum 3/5)

### Experimental Packages (POC branches)
- Relaxed requirements across all dimensions (minimum 2/5)
- Must be clearly marked in CLAUDE.md with ⚠️ EXPERIMENTAL
- Not included in overall repository health score

---

## Remediation Priority

When multiple packages score poorly, prioritize remediation in this order:

1. **Runtime Tier Isolation (1-2 points)** - Can cause runtime errors
2. **Build Configuration (1-2 points)** - Blocks development
3. **ESM Compliance (1-2 points)** - Can cause module resolution errors
4. **Dependency Compliance (1-2 points)** - Can cause version conflicts
5. **Testing Requirements (1-2 points)** - Reduces code quality
6. **Documentation Completeness (1-2 points)** - Impacts team velocity

For scores of 3-4, follow normal sprint planning and prioritization.
