# Audit Engine

This document defines the detailed logic for detecting violations and scoring packages across all six audit dimensions.

## Dimension 1: Runtime Tier Isolation

### Objective
Ensure packages are correctly placed in node/web/core tiers and don't import runtime-specific APIs from wrong tiers.

### Detection Patterns

#### packages/node/* - Node.js Server Packages

**ALLOWED:**
- Node.js APIs: `fs`, `path`, `process`, `http`, `https`, `crypto`, `os`, etc.
- @saga-ed/soa-* node packages
- Other workspace packages/node/* packages
- Core packages (packages/core/*)

**FORBIDDEN:**
- Browser APIs: `window`, `document`, `localStorage`, `sessionStorage`, `navigator`, `DOM`
- Web-specific packages: `packages/web/*`
- @saga-ed/soa-ui or other browser-only packages

**Grep Patterns to Detect Violations:**
```bash
# Search for browser API usage in node packages
grep -r "window\." packages/node/[package-name]/src/
grep -r "document\." packages/node/[package-name]/src/
grep -r "localStorage" packages/node/[package-name]/src/
grep -r "sessionStorage" packages/node/[package-name]/src/
grep -r "navigator\." packages/node/[package-name]/src/
grep -r "import.*from.*@saga-ed/soa-ui" packages/node/[package-name]/src/
```

#### packages/web/* - Browser Client Packages

**ALLOWED:**
- Browser APIs: `window`, `document`, DOM, localStorage, etc.
- React, Svelte, other frontend frameworks
- @saga-ed/soa-ui and other web packages
- Core packages (packages/core/*)

**FORBIDDEN:**
- Node.js APIs: `fs`, `path`, `process`, `http`, `https`, `crypto`, `os`
- @saga-ed/soa-db, @saga-ed/soa-logger, other node-only packages
- Direct database connections

**Grep Patterns to Detect Violations:**
```bash
# Search for Node.js API usage in web packages
grep -r "import.*from.*['\"]fs['\"]" packages/web/[package-name]/src/
grep -r "import.*from.*['\"]path['\"]" packages/web/[package-name]/src/
grep -r "import.*from.*['\"]process['\"]" packages/web/[package-name]/src/
grep -r "import.*from.*['\"]http['\"]" packages/web/[package-name]/src/
grep -r "import.*from.*@saga-ed/soa-db" packages/web/[package-name]/src/
grep -r "import.*from.*@saga-ed/soa-logger" packages/web/[package-name]/src/
```

#### packages/core/* - Runtime-Agnostic Packages

**ALLOWED:**
- Pure TypeScript types
- Zod schemas
- Utility functions (string, array, object manipulation)
- Constants and enums

**FORBIDDEN:**
- Any Node.js-specific APIs
- Any Browser-specific APIs
- Any runtime-specific dependencies

**Grep Patterns to Detect Violations:**
```bash
# Search for runtime-specific imports in core packages
grep -r "import.*from.*['\"]fs['\"]" packages/core/[package-name]/src/
grep -r "import.*from.*['\"]path['\"]" packages/core/[package-name]/src/
grep -r "window\." packages/core/[package-name]/src/
grep -r "document\." packages/core/[package-name]/src/
```

### Scoring

- **5 points**: No violations detected
- **4 points**: 1-2 violations found
- **3 points**: 3-5 violations found
- **2 points**: 6+ violations found
- **1 point**: Critical architectural violation (e.g., db connection in web package)

---

## Dimension 2: ESM Compliance

### Objective
Ensure all packages follow strict ESM patterns as documented in /soa/claude/esm.md.

### Detection Patterns

#### Check 1: .js Extensions in Imports

**PATTERN:** All import statements must include .js extensions

**Grep Patterns:**
```bash
# Find imports missing .js extension (relative imports)
grep -rn "import.*from\s*['\"]\.\.?/" [package]/src/ | grep -v "\.js['\"]"

# Find imports missing /index.js for package imports
grep -rn "import.*from\s*['\"]@saga-ed" [package]/src/ | grep -v "/index\.js['\"]"
```

**Examples:**
```typescript
// ❌ BAD
import { db } from './db'
import { logger } from '@saga-ed/soa-logger'

// ✅ GOOD
import { db } from './db.js'
import { logger } from '@saga-ed/soa-logger/index.js'
```

#### Check 2: package.json "type": "module"

**PATTERN:** Every package.json must have `"type": "module"`

**Detection:**
```bash
# Read package.json and check for "type": "module"
grep -n "\"type\":\s*\"module\"" package.json
```

#### Check 3: No CommonJS require()

**PATTERN:** No require() usage anywhere in source code

**Grep Patterns:**
```bash
# Find require() usage
grep -rn "require(" [package]/src/
grep -rn "require\.resolve" [package]/src/
```

#### Check 4: __dirname Pattern

**PATTERN:** Must use `fileURLToPath(import.meta.url)` pattern, not old __dirname

**Grep Patterns:**
```bash
# Check for old __dirname usage (should be zero)
grep -rn "__dirname" [package]/src/

# Check for correct pattern (if dirname is needed)
grep -rn "fileURLToPath" [package]/src/
grep -rn "import\.meta\.url" [package]/src/
```

**Correct Pattern:**
```typescript
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
```

### Scoring

- **5 points**: Full ESM compliance (all checks pass)
- **4 points**: 1-3 missing .js extensions only
- **3 points**: 4-10 missing .js extensions OR 1 __dirname violation
- **2 points**: CommonJS require() found OR "type": "module" missing
- **1 point**: Multiple critical ESM violations

---

## Dimension 3: Testing Requirements

### Objective
Ensure adequate test coverage and correct testing patterns per /soa/apps/node/claude/testing.md.

### Detection Patterns

#### Check 1: Tests Exist

**PATTERN:** Backend APIs and packages must have test files

**Discovery:**
```bash
# Find test files
find [package]/ -name "*.test.ts" -o -name "*.spec.ts"
```

#### Check 2: Vitest Configuration

**PATTERN:** vitest.config.ts must exist for packages requiring tests

**Detection:**
```bash
# Check for vitest config
ls -la vitest.config.ts
```

#### Check 3: Test Patterns (Backend Only)

**PATTERN:** Tests must follow documented patterns:
- Static imports for controllers (NOT dynamic loading)
- AAA pattern (Arrange, Act, Assert)
- Database isolation via VITEST_POOL_ID

**Grep Patterns:**
```bash
# Check for dynamic import() in tests (should be static)
grep -rn "import(" [package]/test/

# Check for VITEST_POOL_ID usage (database isolation)
grep -rn "VITEST_POOL_ID" [package]/test/
```

#### Check 4: Coverage Requirements (Thrive Only)

**PATTERN:** Thrive requires 100% coverage on service files

**Detection:**
```bash
# Check vitest.config.ts for coverage configuration
grep -A5 "coverage" vitest.config.ts
```

### Scoring

- **5 points**: Complete test coverage meeting requirements
- **4 points**: Tests exist, coverage slightly below target (90%+)
- **3 points**: Tests exist but incomplete (60-89% coverage)
- **2 points**: Minimal testing (< 60% coverage)
- **1 point**: No tests OR tests don't run

---

## Dimension 4: Documentation Completeness

### Objective
Ensure appropriate documentation exists based on package complexity and deviation from tier-level patterns.

### Philosophy

Not all packages require dedicated CLAUDE.md files. Simple packages that perfectly follow tier-level patterns and are well-described in tier documentation may skip project-level CLAUDE.md without penalty.

### When CLAUDE.md is Required

A package SHOULD have CLAUDE.md when it:
- **Deviates from tier conventions** (needs ⚠️ Convention Deviations section)
- **Has complex responsibilities** not obvious from package name
- **Has unique tech stack** beyond tier defaults
- **Has non-obvious usage patterns** or special requirements
- **Is large/complex** with sub-components or sectors
- **Has special constraints** (e.g., 100% coverage, specific dependencies)

### When CLAUDE.md is Optional

A package MAY skip CLAUDE.md when it:
- **Perfectly follows tier patterns** with zero deviations
- **Is simple/single-purpose** (pure types, basic utility, etc.)
- **Has no unique conventions** beyond tier documentation
- **Is self-documenting** with clear code and standard patterns
- **Well-described in tier CLAUDE.md** with adequate detail

### Detection Patterns

#### Check 1: CLAUDE.md Hierarchy

**PATTERN:** Hierarchy levels that MUST have CLAUDE.md:

**Required (no exceptions):**
```
/CLAUDE.md                          # Root - REQUIRED
/apps/CLAUDE.md                     # Category - REQUIRED
/packages/CLAUDE.md                 # Category - REQUIRED
/apps/node/CLAUDE.md                # Tier - REQUIRED
/apps/web/CLAUDE.md                 # Tier - REQUIRED (if tier exists)
/packages/node/CLAUDE.md            # Tier - REQUIRED
/packages/web/CLAUDE.md             # Tier - REQUIRED (if tier exists)
/packages/core/CLAUDE.md            # Tier - REQUIRED
```

**Conditional (project-level):**
```
/apps/node/[app-name]/CLAUDE.md     # Project - REQUIRED for apps (always complex)
/packages/node/[pkg-name]/CLAUDE.md # Project - CONDITIONAL (see criteria above)
/packages/core/[pkg-name]/CLAUDE.md # Project - CONDITIONAL (see criteria above)
/packages/web/[pkg-name]/CLAUDE.md  # Project - CONDITIONAL (see criteria above)
```

#### Check 2: Assess Package Complexity

**PATTERN:** Determine if package is simple or complex

**Complexity Indicators (requires CLAUDE.md):**
```bash
# Check for unique dependencies beyond tier standard
grep -c "dependencies" package.json

# Check for complex directory structure
find src/ -type d | wc -l  # >5 directories suggests complexity

# Check for custom build configuration
ls -la vitest.config.ts tsconfig.json turbo.json

# Check for deviations mentioned in tier CLAUDE.md
grep "[pkg-name]" ../CLAUDE.md | grep "⚠️"

# Check if package exports multiple entry points
grep -c "exports" package.json
```

**Simplicity Indicators (CLAUDE.md optional):**
- Single src/index.ts or src/index.tsx file
- Only type definitions (no runtime code)
- No custom build config beyond tier defaults
- Well-described in tier-level CLAUDE.md (1-2 sentence description)
- Zero dependencies beyond tier standards

#### Check 3: Required Sections (if CLAUDE.md exists)

**PATTERN:** Project-level CLAUDE.md should include:
1. Title and tagline
2. Responsibilities (what this package does)
3. Parent Context (link to parent CLAUDE.md)
4. Tech Stack
5. Key Commands
6. Convention Deviations (if any, marked with ⚠️)
7. See Also (links to detailed docs)

**Detection:**
```bash
# Check for section headers
grep -n "^#" CLAUDE.md
grep -n "Parent Context" CLAUDE.md
grep -n "Tech Stack" CLAUDE.md
grep -n "Convention Deviations" CLAUDE.md
```

#### Check 4: "See" Directives Point to Real Files

**PATTERN:** All referenced files must exist

**Detection:**
- Parse CLAUDE.md for "See [file](path)" patterns
- Verify each path exists
- Check markdown links are valid

#### Check 5: Token Budget

**PATTERN:** CLAUDE.md should be ~500 tokens, max 1000 tokens

**Detection:**
```bash
# Count approximate tokens (words * 1.3)
wc -w CLAUDE.md
# If > 750 words (~975 tokens), violation
```

#### Check 6: Description in Tier CLAUDE.md (if no project CLAUDE.md)

**PATTERN:** If package has no CLAUDE.md, it must be described in tier-level CLAUDE.md

**Detection:**
```bash
# Check if package is mentioned in tier CLAUDE.md
grep "[pkg-name]" /apps/node/CLAUDE.md
grep "[pkg-name]" /packages/core/CLAUDE.md
```

### Scoring

**5 points** - Either:
- Complete CLAUDE.md with all sections, token budget compliant, OR
- Simple package with no CLAUDE.md, well-described in tier docs, zero deviations

**4 points**:
- CLAUDE.md exists, 1-2 minor sections missing, OR
- Simple package with minor deviation noted in tier docs

**3 points**:
- CLAUDE.md exists but incomplete (3-4 sections missing), OR
- No CLAUDE.md but package has moderate complexity/deviations, OR
- Token budget exceeded (>1000 tokens)

**2 points**:
- CLAUDE.md severely incomplete (>50% missing), OR
- Complex package with significant deviations but no CLAUDE.md

**1 point**:
- Critical/complex package with NO documentation, OR
- Package has major deviations but no CLAUDE.md AND not mentioned in tier docs, OR
- Apps (always complex) missing CLAUDE.md

---

## Dimension 5: Dependency Compliance

### Objective
Ensure correct dependency versions, pnpm usage, and workspace configuration.

### Detection Patterns

#### Check 1: SOA Version Matching (Coach/Thrive Only)

**PATTERN:** All @saga-ed/soa-* package versions must exactly match SOA repo versions

**Detection:**
```bash
# Read package.json dependencies
grep "@saga-ed/soa-" package.json

# Compare with soa/packages/[package]/package.json version
```

#### Check 2: pnpm Usage

**PATTERN:** Only pnpm allowed (never npm/yarn)

**Detection:**
```bash
# Check for lock files
ls -la package-lock.json  # Should NOT exist
ls -la yarn.lock          # Should NOT exist
ls -la pnpm-lock.yaml     # Should exist at root
```

#### Check 3: Workspace Configuration

**PATTERN:** pnpm-workspace.yaml must be configured at root

**Detection:**
```bash
# Check workspace config
cat pnpm-workspace.yaml
```

#### Check 4: Banned Packages

**PATTERN:** Prettier is banned (ESLint only)

**Detection:**
```bash
# Check for Prettier
grep "prettier" package.json
```

#### Check 5: Cross-Repo Linking Configuration (Coach/Thrive Only)

**PATTERN:** Consuming repos (coach, thrive) must have proper SOA linking configuration

**Required Configuration:**

1. **`soa-link.json`** - Config file listing packages and paths
2. **npm scripts** (optional but recommended) - `soa:link:status`, `soa:link:on`, `soa:link:off` pointing to `../soa/scripts/cross-repo-link.sh`
3. **Clean state** - `pnpm.overrides` must NOT contain SOA package links (linking should be OFF by default)

**Detection:**
```bash
# Verify soa-link.json exists and has required fields
test -f soa-link.json
jq '.soaPath, .packages' soa-link.json

# Check npm scripts (optional but recommended)
grep "soa:link:status" package.json
grep "cross-repo-link.sh" package.json

# Verify linking is OFF (no SOA packages in overrides)
jq '.pnpm.overrides | keys | map(select(test("@saga-ed/soa-")))' package.json
# Should return empty array []
```

**Validation Rules:**

1. `soa-link.json` must exist in repo root
2. All packages used in the repo (found in workspace package.json files) must be listed in `soa-link.json`
3. `soaPath` must point to correct relative path (typically `../soa`)
4. Linking must be OFF by default (overrides should be empty or not contain SOA packages)
5. If npm scripts exist, they should use `../soa/scripts/cross-repo-link.sh`

**Common Violations:**

- Missing `soa-link.json` file
- Missing SOA packages used by the repo in `soa-link.json`
- Incorrect `soaPath` in `soa-link.json`
- Linking enabled (SOA packages in overrides) - should be OFF for commits
- npm scripts pointing to non-existent local script instead of central script

### Scoring

- **5 points**: All dependencies correct, versions matched, pnpm only, linking config complete and consistent
- **4 points**: Minor version mismatches (patch level only) OR 1-2 missing packages in linking config OR missing npm scripts
- **3 points**: Moderate version mismatches (minor level) OR incomplete linking config (missing soa-link.json)
- **2 points**: Major version mismatches OR incorrect dependencies OR broken linking config
- **1 point**: Wrong package manager OR banned packages found OR linking enabled (should be OFF)

---

## Dimension 6: Build Configuration

### Objective
Ensure correct build tooling configuration (turbo, tsconfig, vitest).

### Detection Patterns

#### Check 1: Turborepo Configuration

**PATTERN:** turbo.json must exist at root with correct pipeline

**Detection:**
```bash
# Check turbo.json exists
ls -la turbo.json

# Check for standard tasks
grep "build" turbo.json
grep "test" turbo.json
grep "lint" turbo.json
```

#### Check 2: TypeScript Configuration

**PATTERN:** Each package must have tsconfig.json with correct inheritance

**Detection:**
```bash
# Check tsconfig.json exists
ls -la tsconfig.json

# Check extends
grep "extends" tsconfig.json
# Should extend from @saga-ed/soa-typescript-config
```

#### Check 3: Vitest Configuration (if tests exist)

**PATTERN:** If tests exist, vitest.config.ts must be present

**Detection:**
```bash
# If test files exist
if [ -n "$(find . -name '*.test.ts')" ]; then
  ls -la vitest.config.ts
fi
```

#### Check 4: package.json Scripts

**PATTERN:** Standard scripts must be present

**Detection:**
```bash
# Check for standard scripts
grep "\"build\":" package.json
grep "\"test\":" package.json
grep "\"lint\":" package.json
```

### Scoring

- **5 points**: Complete and correct build configuration
- **4 points**: Minor issues (missing optional scripts)
- **3 points**: Moderate issues (incorrect tsconfig inheritance)
- **2 points**: Significant issues (missing turbo.json tasks)
- **1 point**: No build configuration OR broken build

---

## Violation Report Templates

### Template: ESM Compliance Violation

```
ESM Compliance: [SCORE]/5
───────────────────────────────────────────────────────────────
❌ Missing .js extensions in imports:
   - src/routers/user.ts:3 → import { db } from './db'
   - src/routers/auth.ts:5 → import { logger } from '@saga-ed/soa-logger'

REMEDIATION:
  Add .js extensions to all import statements:
  - import { db } from './db.js'
  - import { logger } from '@saga-ed/soa-logger/index.js'
```

### Template: Runtime Tier Violation

```
Runtime Tier Isolation: [SCORE]/5
───────────────────────────────────────────────────────────────
❌ Browser APIs used in Node.js package:
   - src/utils/storage.ts:12 → localStorage.getItem('key')
   - src/utils/dom.ts:5 → document.querySelector('.class')

REMEDIATION:
  This is a packages/node/* package and must not use browser APIs.
  Either:
  1. Move this code to packages/web/* if it's browser-specific, OR
  2. Remove browser API usage and use Node.js alternatives
```

### Template: Testing Violation

```
Testing Requirements: [SCORE]/5
───────────────────────────────────────────────────────────────
❌ No test files found for service files:
   - src/services/user.service.ts (0% coverage)
   - src/services/auth.service.ts (0% coverage)

REMEDIATION:
  Create test files following AAA pattern:
  - test/services/user.service.test.ts
  - test/services/auth.service.test.ts

  See: /soa/apps/node/claude/testing.md for patterns
```

### Template: Documentation Violation (Complex Package)

```
Documentation Completeness: [SCORE]/5
───────────────────────────────────────────────────────────────
❌ Missing CLAUDE.md file

ANALYSIS:
  This package requires CLAUDE.md because it:
  - Has unique tech stack beyond tier defaults
  - Contains custom build configuration
  - Has complex directory structure (8 subdirectories)

REMEDIATION:
  Create CLAUDE.md with required sections:
  1. Title and tagline
  2. Responsibilities
  3. Parent Context (link to /apps/node/CLAUDE.md)
  4. Tech Stack
  5. Key Commands
  6. Convention Deviations (if any, marked with ⚠️)
  7. See Also

  See templates in the documentation-system@saga-tools plugin
```

### Template: Documentation Violation (Simple Package - Optional)

```
Documentation Completeness: 5/5
───────────────────────────────────────────────────────────────
✅ No CLAUDE.md needed

ANALYSIS:
  This package is simple enough that CLAUDE.md is optional:
  - Single src/index.ts file (pure types)
  - Zero deviations from tier patterns
  - Well-described in /packages/core/CLAUDE.md
  - No unique dependencies or build config

STATUS: Compliant without project-level documentation
```

### Template: Documentation Violation (Incomplete)

```
Documentation Completeness: [SCORE]/5
───────────────────────────────────────────────────────────────
❌ CLAUDE.md incomplete - missing key sections

MISSING SECTIONS:
  - Tech Stack
  - Key Commands
  - See Also (links to detailed docs)

REMEDIATION:
  Add missing sections to CLAUDE.md:

  ## Tech Stack
  - [List framework, libraries, patterns]

  ## Key Commands
  ```bash
  pnpm build
  pnpm test
  ```

  ## See Also
  - [Link to parent context and related docs]
```

### Template: Dependency Violation

```
Dependency Compliance: [SCORE]/5
───────────────────────────────────────────────────────────────
❌ Version mismatch with SOA packages:
   - @saga-ed/soa-db: ^1.2.3 (should be 1.2.0 to match SOA)
   - @saga-ed/soa-logger: ^2.0.0 (should be 1.5.0 to match SOA)

REMEDIATION:
  Update package.json to match SOA versions exactly:
  {
    "dependencies": {
      "@saga-ed/soa-db": "1.2.0",
      "@saga-ed/soa-logger": "1.5.0"
    }
  }

  Then run: pnpm install
```

### Template: Build Configuration Violation

```
Build Configuration: [SCORE]/5
───────────────────────────────────────────────────────────────
❌ Missing tsconfig.json inheritance

REMEDIATION:
  Update tsconfig.json to extend from shared config:
  {
    "extends": "@saga-ed/soa-typescript-config/base.json",
    "compilerOptions": {
      "outDir": "./dist"
    }
  }
```

### Template: Cross-Repo Linking Configuration Violation

```
Dependency Compliance: [SCORE]/5
───────────────────────────────────────────────────────────────
❌ Incomplete or missing cross-repo linking configuration

ISSUES FOUND:
  - Missing soa-link.json file
  - Missing @saga-ed/soa-aws-util in soa-link.json (used in apps/node/coach-api)
  - Missing npm scripts: soa:link:status, soa:link:on, soa:link:off
  - Linking is ENABLED (pnpm.overrides contains SOA packages - should be OFF)

REMEDIATION:
  1. Create or update soa-link.json to include all used packages:
  {
    "soaPath": "../soa",
    "packages": {
      "@saga-ed/soa-api-core": "packages/node/api-core",
      "@saga-ed/soa-aws-util": "packages/node/aws-util",
      "@saga-ed/soa-config": "packages/core/config",
      "@saga-ed/soa-db": "packages/node/db",
      "@saga-ed/soa-logger": "packages/node/logger"
    }
  }

  2. Add npm scripts to package.json (optional but recommended):
  {
    "scripts": {
      "soa:link:status": "../soa/scripts/cross-repo-link.sh status",
      "soa:link:on": "../soa/scripts/cross-repo-link.sh on",
      "soa:link:off": "../soa/scripts/cross-repo-link.sh off"
    }
  }

  3. If linking is enabled, turn it OFF before committing:
  pnpm soa:link:off

  See: /soa/docs/cross-repo-linking-summary.md for details
```

---

## Automation Notes

This audit is **prompt-driven** - Claude reads files and searches for patterns using Grep and Read tools. No external scripts are required, though scripts/ directory can optionally contain validation scripts for CI/CD integration.

## Example Grep Workflow

```bash
# For ESM compliance in a package
cd /home/skelly/dev/soa/packages/node/db

# Find imports missing .js
grep -rn "from\s*['\"]\.\.?/" src/ | grep -v "\.js['\"]"

# Find require() usage
grep -rn "require(" src/

# Check package.json
grep "\"type\":" package.json
```
