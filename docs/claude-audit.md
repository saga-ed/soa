# Claude Audit Skill

> **Automated compliance auditing for soa, coach, and thrive repositories**

## Overview

The `claude-audit` skill is a comprehensive repository compliance auditor that evaluates your codebase against documented constraints in hierarchical CLAUDE.md files. It provides actionable insights into code health, architectural compliance, and adherence to team standards.

## Purpose

In a monorepo architecture with shared infrastructure, maintaining consistency is critical. The claude-audit skill:

- **Evaluates compliance** across 6 critical dimensions (runtime isolation, ESM patterns, testing, documentation, dependencies, build configuration)
- **Generates actionable reports** with specific violations and remediation steps
- **Provides objective scoring** using a 5-point scale
- **Tracks trends over time** when reports are versioned in git
- **Identifies architectural violations** before they become technical debt

## How It Works

### Audit Process

The skill follows a four-phase process:

1. **Context Loading**: Reads hierarchical CLAUDE.md files and follows "See" directives to understand documented standards
2. **Discovery**: Scans directory structure to find all apps and packages
3. **Evaluation**: Checks each app/package against 6 dimensions using pattern matching and file analysis
4. **Reporting**: Generates detailed compliance reports with scores and remediation steps

### Audit Dimensions

Each app/package is evaluated across **six dimensions** on a 1-5 scale:

| Dimension | What It Checks |
|-----------|----------------|
| **Runtime Tier Isolation** | Correct separation of node/web/core packages, no forbidden imports |
| **ESM Compliance** | .js extensions, "type": "module", no require(), correct __dirname |
| **Testing Requirements** | Vitest tests, coverage levels, correct patterns (AAA, static imports) |
| **Documentation Completeness** | CLAUDE.md hierarchy, required sections, token budgets |
| **Dependency Compliance** | Version matching (coach/thrive → soa), pnpm usage, no banned packages |
| **Build Configuration** | turbo.json, tsconfig.json, vitest.config.ts, package.json scripts |

See [rating-criteria.md](../.claude/skills/claude-audit/rating-criteria.md) for detailed scoring rubrics.

### Scoring System

**5-Point Scale:**
- ✅ **5.0 - Excellent**: Fully compliant
- ✅ **4.0-4.5 - Good**: Minor issues only
- ⚠️ **3.0-3.5 - Fair**: Moderate compliance gaps
- ❌ **2.0-2.5 - Poor**: Significant compliance issues
- ❌ **1.0-1.5 - Critical**: Major violations requiring immediate attention

**Composite Score:** Average of all 6 dimension scores, rounded to nearest 0.5

**Repository Health:** Average of all package composite scores

## Usage

### Running an Audit

**From Claude Code CLI:**
```bash
# Navigate to any of the three repos
cd /home/skelly/dev/soa
# OR
cd /home/skelly/dev/coach
# OR
cd /home/skelly/dev/thrive

# Invoke the skill (when skill discovery is working)
/claude-audit
```

**Manual Execution (if skill not discovered):**
```
Ask Claude: "Execute the claude-audit skill for this repository"
```

### Understanding Reports

Audit reports are generated in the repository root:
- `/home/skelly/dev/soa/soa-audit.md`
- `/home/skelly/dev/coach/coach-audit.md`
- `/home/skelly/dev/thrive/thrive-audit.md`

**Report Structure:**

1. **Summary Section** - One line per package with composite score
   ```
   [4.5] ✅ trpc-api - Minor ESM issues (3 missing .js extensions)
   [3.5] ⚠️  rest-api - Moderate testing gaps
   ```

2. **Detailed Findings** - Only for packages scoring ≤4.0
   - Specific violations with file/line references
   - Dimension-by-dimension breakdown
   - Actionable remediation steps

3. **Overall Health** - Repository-wide compliance score
   ```
   OVERALL REPO HEALTH: 4.2/5.0 (Good)
   ```

### Interpreting Scores

| Score Range | Interpretation | Recommended Action |
|-------------|----------------|-------------------|
| **5.0** | Excellent | No action required, maintain standards |
| **4.0-4.5** | Good | Fix minor issues in next iteration |
| **3.0-3.5** | Fair | Schedule remediation work soon (moderate priority) |
| **2.0-2.5** | Poor | Address immediately (high priority) |
| **1.0-1.5** | Critical | Drop everything and fix (blocking issue) |

## Real-World Results

### SOA Repository Audit (2026-01-30)

**Overall Health: 2.9/5.0 (Poor)**

**Key Findings:**
- 22 packages evaluated
- 0 packages with CLAUDE.md (0% documentation compliance)
- 9 packages with zero tests (41% of repository)
- 35 __dirname ESM violations across 7 packages
- 1 critical runtime tier violation (tgql-codegen using Node.js APIs in core package)

**Impact:** Identified architectural violation and systemic documentation gap requiring immediate attention.

### Coach Repository Audit (2026-01-30)

**Overall Health: 3.6/5.0 (Fair)**

**Key Findings:**
- 3 packages evaluated
- 1 architectural violation: `coach-lib` misplaced in packages/node instead of packages/core
- 3 missing CLAUDE.md files (100% documentation gap)
- Perfect ESM compliance (5/5 across all packages)
- Strong build configuration (4.5/5 average)

**Impact:** Caught architectural misplacement preventing proper code sharing between frontend/backend.

### Thrive Repository Audit (2026-01-30)

**Overall Health: 4.0/5.0 (Good)**

**Key Findings:**
- 7 packages evaluated
- Prettier installed (banned package) - immediate fix required
- All @saga-ed/soa-* packages at wrong version (1.0.x instead of 1.1.x)
- 7 missing project-level CLAUDE.md files
- Strong testing culture in jobs-api (100% coverage)
- Minimal testing in 4 packages

**Impact:** Identified banned package and version mismatches before deployment issues occurred.

## Common Violations and Fixes

### ESM Compliance Issues

**Problem:** Missing .js extensions in imports
```typescript
// ❌ Violation
import { db } from './db'
import { logger } from '@saga-ed/soa-logger'
```

**Fix:**
```typescript
// ✅ Compliant
import { db } from './db.js'
import { logger } from '@saga-ed/soa-logger/index.js'
```

### Runtime Tier Violations

**Problem:** Node.js APIs in core package
```typescript
// ❌ Violation (in packages/core/*)
import fs from 'fs';
```

**Fix:** Move package to `packages/node/` OR remove Node.js dependencies

### Documentation Gaps

**Problem:** Missing CLAUDE.md file

**Fix:** Create CLAUDE.md with required sections:
1. Title and tagline
2. Responsibilities
3. Parent Context
4. Tech Stack
5. Key Commands
6. See Also

See templates in `.claude/skills/documentation-system/templates/`

### Dependency Version Mismatches

**Problem:** Coach/Thrive using different soa package versions
```json
// ❌ In coach/package.json
"@saga-ed/soa-db": "^1.0.0"  // SOA has 1.2.0
```

**Fix:**
```json
// ✅ Exact match required
"@saga-ed/soa-db": "1.2.0"
```

## Tracking Compliance Over Time

**Best Practice:** Version audit reports in git to track trends

```bash
# After running audit
git add soa-audit.md
git commit -m "chore: monthly compliance audit (2026-01)"

# Later, compare reports
git diff HEAD~1 soa-audit.md
```

**Benefits:**
- Track improvement over time
- Identify recurring issues
- Measure remediation effectiveness
- Demonstrate compliance to stakeholders

## Implementation Details

### Skill Location

The skill is defined in `/home/skelly/dev/soa/.claude/skills/claude-audit/` with three core files:

- **SKILL.md** - Skill definition, frontmatter, execution instructions
- **audit-engine.md** - Detailed violation detection rules and patterns
- **rating-criteria.md** - 5-point scale definitions for each dimension

### Detection Mechanisms

The skill uses:
- **File reading** - Reads CLAUDE.md, package.json, tsconfig.json, etc.
- **Pattern matching** - Uses Grep to find violations (missing .js, require(), browser APIs, etc.)
- **Structure analysis** - Verifies directory hierarchy and file placement
- **Version comparison** - Checks dependency versions across repos

### Extensibility

The skill can be extended by:
1. Adding new dimensions to audit-engine.md
2. Updating scoring criteria in rating-criteria.md
3. Adding validation scripts to `scripts/` directory
4. Creating CI/CD integration for automated audits

## FAQ

### Q: Can I exclude packages from the audit?

**A:** Not currently. All packages in apps/ and packages/ are evaluated. Mark experimental packages with ⚠️ EXPERIMENTAL in their CLAUDE.md to indicate relaxed requirements.

### Q: How often should I run audits?

**A:** Recommended frequency:
- **Monthly** - For stable repositories
- **Weekly** - During active development
- **Pre-release** - Before major deployments
- **Post-merge** - After large PRs or architectural changes

### Q: What if my package has legitimate deviations?

**A:** Document deviations in the package's CLAUDE.md under "Convention Deviations" section with ⚠️ marker and justification. The audit will note the deviation but understand it's intentional.

### Q: Can I customize the scoring thresholds?

**A:** Yes, edit [rating-criteria.md](../.claude/skills/claude-audit/rating-criteria.md) to adjust the 5-point scale thresholds for each dimension.

### Q: How do I fix all violations at once?

**A:** Don't. The audit report includes a prioritized remediation roadmap. Follow the priority order:
1. Critical violations (scores 1-2) - Immediate
2. Poor compliance (scores 2-3) - High priority
3. Fair compliance (scores 3-4) - Medium priority
4. Good compliance (scores 4-5) - Low priority

## Roadmap

**Future enhancements:**
- [ ] CI/CD integration (GitHub Actions workflow)
- [ ] Automated remediation suggestions via shell scripts
- [ ] Historical trend visualization
- [ ] Package exclusion/inclusion filters
- [ ] Custom dimension definitions
- [ ] Integration with documentation-system skill
- [ ] Real-time audit during development

## See Also

- [SKILL.md](../.claude/skills/claude-audit/SKILL.md) - Skill implementation details
- [audit-engine.md](../.claude/skills/claude-audit/audit-engine.md) - Violation detection rules
- [rating-criteria.md](../.claude/skills/claude-audit/rating-criteria.md) - Scoring rubrics
- [CLAUDE.md](../CLAUDE.md) - SOA repository standards
- [claude/esm.md](../claude/esm.md) - ESM patterns
- [apps/node/claude/testing.md](../apps/node/claude/testing.md) - Testing patterns

---

**Questions or feedback?** Open an issue in the SOA repository or discuss with the team in #claude-code channel.
