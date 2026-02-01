---
name: claude-audit
description: Systematically evaluate repository compliance with documented constraints in hierarchical CLAUDE.md files. Generates compliance reports with 5-point ratings for each app/package across soa, coach, and thrive repositories. Use when you need to assess codebase health, verify adherence to documented patterns, or identify non-compliant packages.
---

# Claude Audit Skill

## Purpose

This skill performs systematic compliance audits of soa, coach, and thrive repositories against their documented constraints in hierarchical CLAUDE.md files. It evaluates each app and package across six critical dimensions and generates actionable compliance reports.

## When to Use

Invoke this skill when you need to:
- Assess overall repository health and compliance
- Verify adherence to documented architectural patterns
- Identify non-compliant packages requiring remediation
- Generate compliance reports for review
- Track compliance trends over time (by versioning reports in git)

## How It Works

The skill follows a four-phase process:

### Phase 1: Context Loading
1. Detect current repository (soa, coach, or thrive)
2. Read root CLAUDE.md
3. If coach/thrive: Read ../soa/CLAUDE.md (source of truth)
4. Follow ALL "See" directives to load referenced documentation

### Phase 2: Discovery
1. Scan directory structure to find all apps and packages
2. Map each to expected hierarchy level (root → category → tier → project)
3. Build complete inventory

### Phase 3: Evaluation
For each app/package:
1. Read its CLAUDE.md (if exists)
2. Read package.json and tsconfig.json
3. Scan source files for violations
4. Run six dimension checks (see rating-criteria.md)
5. Calculate dimension scores and composite score

### Phase 4: Reporting
1. Generate one-line summary per app/package with composite score
2. For scores ≤4.0: Generate detailed findings with specific violations
3. Group findings by dimension
4. Include actionable remediation steps
5. Persist report to `[repo]-audit.md` in repository root

## Audit Dimensions

Each app/package is evaluated across **six dimensions** (1-5 scale):

1. **Runtime Tier Isolation** - Correct separation of node/web/core packages
2. **ESM Compliance** - Proper ESM patterns (.js extensions, no require(), etc.)
3. **Testing Requirements** - Vitest tests, coverage, patterns
4. **Documentation Completeness** - CLAUDE.md hierarchy and content
5. **Dependency Compliance** - Version matching, pnpm usage, workspace config
6. **Build Configuration** - turbo.json, tsconfig.json, scripts

See [rating-criteria.md](./rating-criteria.md) for detailed scoring rubrics.

See [audit-engine.md](./audit-engine.md) for detailed audit rules and patterns.

## Overall Rating Calculation

**Composite Score:** Average of all six dimension scores, rounded to nearest 0.5

**Compliance Levels:**
- ✅ **5.0 - Excellent**: Fully compliant
- ✅ **4.0-4.5 - Good**: Minor issues only
- ⚠️ **3.0-3.5 - Fair**: Moderate compliance gaps
- ❌ **2.0-2.5 - Poor**: Significant compliance issues
- ❌ **1.0-1.5 - Critical**: Major violations requiring immediate attention

## Report Format

### High-Level Summary (One Line Per Package)

```
REPOSITORY: soa
═══════════════════════════════════════════════════════════════

APPS/NODE
─────────────────────────────────────────────────────────────
[5.0] ✅ gql-api         - Fully compliant
[4.5] ✅ trpc-api        - Minor ESM issues (3 missing .js extensions)
[3.5] ⚠️  rest-api        - Moderate testing gaps
[2.0] ❌ tgql-api        - Significant doc + test issues

PACKAGES/NODE
─────────────────────────────────────────────────────────────
[5.0] ✅ db              - Fully compliant
[4.0] ✅ logger          - Minor build config issues
...

OVERALL REPO HEALTH: 4.2/5.0 (Good)
```

### Detailed Findings (Scores ≤4.0)

```
════════════════════════════════════════════════════════════════
DETAILED FINDINGS: trpc-api (4.5/5.0)
════════════════════════════════════════════════════════════════

ESM Compliance: 4/5
───────────────────────────────────────────────────────────────
❌ Missing .js extensions in imports:
   - src/routers/user.ts:3 → import { db } from './db'
   - src/routers/auth.ts:5 → import { logger } from '@saga-ed/soa-logger'
   - src/utils/helper.ts:12 → import { format } from './format'

REMEDIATION:
  Add .js extensions to all import statements:
  - import { db } from './db.js'
  - import { logger } from '@saga-ed/soa-logger/index.js'
  - import { format } from './format.js'

────────────────────────────────────────────────────────────────

[All other dimensions scored 5/5]
```

## Execution Instructions

When invoked, you must:

1. **Load Context**
   - Read the root CLAUDE.md of the current repository
   - If in coach/thrive, read ../soa/CLAUDE.md
   - Follow all "See" directives to load referenced docs (esm.md, testing.md, etc.)

2. **Discover Packages**
   - Use Glob to find all apps/ and packages/ directories
   - Build inventory mapping each to hierarchy level
   - For each directory, check for package.json to confirm it's a package

3. **Evaluate Each Package**
   - For each app/package, run all six dimension checks
   - Use Grep to search for violations (imports without .js, require(), browser APIs in node packages, etc.)
   - Read key files (CLAUDE.md, package.json, tsconfig.json, vitest.config.ts)
   - Calculate scores based on rating-criteria.md rubrics

4. **Generate Report**
   - Format report according to templates above
   - Include one-line summary for ALL packages
   - Include detailed findings ONLY for scores ≤4.0
   - Calculate overall repo health (average of all composite scores)
   - Persist to `[repo]-audit.md` in repository root

5. **Cross-Repo Execution**
   - The skill can be run from any of the three repos
   - Always save report to current repository root
   - When auditing coach/thrive, check soa version compliance

## Example Invocation

```
# From any repo (soa, coach, or thrive)
skill: "claude-audit"

# Optionally with args (not currently implemented)
skill: "claude-audit", args: "--verbose"
```

## Report Persistence

Reports are saved to:
- `/home/skelly/dev/soa/soa-audit.md`
- `/home/skelly/dev/coach/coach-audit.md`
- `/home/skelly/dev/thrive/thrive-audit.md`

These can be versioned in git to track compliance trends over time.

## Important Notes

- The skill is **read-only** - it never modifies code, only generates reports
- Scoring is **objective** - based on concrete violations detected via Grep and file reading
- Remediation steps are **actionable** - specific file/line references and fixes
- Reports can be **versioned** - commit them to track compliance over time
- The skill **respects CLAUDE.md hierarchy** - loads context as documented

## See Also

- [audit-engine.md](./audit-engine.md) - Detailed audit logic and violation detection rules
- [rating-criteria.md](./rating-criteria.md) - 5-point scale definitions for each dimension
- [/soa/docs/claude-audit.md](../../docs/claude-audit.md) - User-facing documentation
