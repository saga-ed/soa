---
name: qa-cross-validation
description: Set up a QA team with two independent testers that cross-validate each other's work. Uses Claude Code experimental agent teams to run parallel test passes, swap sections, and produce an agreement matrix highlighting confirmed passes, confirmed failures, and disagreements requiring investigation.
---

# QA Cross-Validation Skill

## Purpose

This skill sets up a 3-agent QA team that independently verifies a feature or deployment using cross-validation. Two testers each run half the test plan, then swap sections, producing 4 reports that the QA lead analyzes for agreement and disagreement.

## When to Use

Invoke this skill when you need to:
- Verify a deployment or fixture against requirements
- Validate database state matches expected configuration
- Run acceptance tests that require querying live systems (VMs, APIs, databases)
- Get high-confidence results by having two independent observers

## Prerequisites

Experimental teams must be enabled:

```bash
export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
```

## How It Works

### Phase 1: Test Plan Split

The QA lead (you) divides the requirements into two roughly equal sections:

| Section A (Configuration/Static) | Section B (Relationships/Dynamic) |
|----------------------------------|-----------------------------------|
| Entity existence and properties | Entity-to-entity assignments |
| Config values (names, settings) | Cross-entity relationships |
| Individual resource verification | Schedule/session data |
| Static data correctness | Behavioral/computed data |

**Rules for splitting:**
1. Roughly equal test counts per section
2. Minimize cross-dependencies between sections
3. Each section independently runnable
4. Group related tests together (don't split categories)
5. Each test is a single, self-contained verification

### Phase 2: First Pass (parallel)

Spawn two testers simultaneously:

```
TeamCreate:
  team_name: "<project>-qa"
  description: "QA cross-validation for <feature>"
  agent_type: "qa-lead"

Task (qa-tester-alpha):
  subagent_type: general-purpose
  team_name: "<project>-qa"
  mode: bypassPermissions
  run_in_background: true
  prompt: |
    You are QA Tester Alpha on the <project>-qa team.

    ## Your Test Section (Section A)
    <test items with IDs, descriptions, expected values>

    ## How to Test
    <environment access: SSH commands, DB queries, API calls>

    ## Output
    Write report to: <path>/qa-report-alpha-section-a.md
    Send summary to qa-lead when done.

Task (qa-tester-beta):
  subagent_type: general-purpose
  team_name: "<project>-qa"
  mode: bypassPermissions
  run_in_background: true
  prompt: |
    You are QA Tester Beta on the <project>-qa team.

    ## Your Test Section (Section B)
    <test items with IDs, descriptions, expected values>

    ## How to Test
    <environment access: SSH commands, DB queries, API calls>

    ## Output
    Write report to: <path>/qa-report-beta-section-b.md
    Send summary to qa-lead when done.
```

### Phase 3: Section Swap (parallel)

After first pass completes, send swap instructions:

```
SendMessage -> qa-tester-alpha:
  "First pass complete. Now run Section B.
   [Include any corrections discovered during first pass]
   Write report to: <path>/qa-report-alpha-section-b.md"

SendMessage -> qa-tester-beta:
  "First pass complete. Now run Section A.
   [Include any corrections discovered during first pass]
   Write report to: <path>/qa-report-beta-section-a.md"
```

**Key insight:** Between phases 2 and 3, the QA lead can investigate any FAILs or WARNs from the first pass. If a tester checked the wrong data source, the swap instructions should include corrections so the second tester gets it right.

### Phase 4: Cross-Validation Analysis

QA lead reads all 4 reports and produces the agreement matrix:

```
Alpha-A vs Beta-A  →  Two independent observations of Section A
Alpha-B vs Beta-B  →  Two independent observations of Section B
```

| Outcome | Meaning | Action |
|---------|---------|--------|
| Both PASS | **CONFIRMED PASS** | No action |
| Both FAIL | **CONFIRMED FAIL** | Fix required |
| Both WARN | **CONFIRMED WARN** | Investigate or accept |
| PASS vs FAIL | **DISAGREE** | QA lead investigates root cause |
| PASS vs WARN | **RESOLVED** | QA lead determines which is correct |

### Phase 5: Cleanup

```
SendMessage (shutdown_request) -> qa-tester-alpha
SendMessage (shutdown_request) -> qa-tester-beta
TeamDelete
```

## Test Report Format

Each tester produces one report per section:

```markdown
# QA Report - [Tester] - Section [A/B]

**Date:** YYYY-MM-DD
**Feature:** <what's being tested>

## [Category Name]

### [Test ID] - [Test Name]
- **Description:** What is being verified
- **Expected:** Expected value or condition
- **Actual:** Observed value or condition
- **Source:** Where the data was queried from
- **Status:** PASS | FAIL | WARN
- **Notes:** (if FAIL or WARN) Explanation

## Summary
| Section | Tests | Pass | Fail | Warn |
|---------|-------|------|------|------|
| ...     | N     | N    | N    | N    |
```

## Final Report Format

See `templates/cross-validation-summary.md` for the full template.

Key sections:
- **Agreement Matrix** - Per-test comparison of Alpha vs Beta results
- **Resolution Notes** - Explanation of disagreements
- **Remaining Work** - Actionable checklist of fixes and investigations

## Why Cross-Validation?

- Two independent observers catch tester-specific blind spots (wrong query, wrong table, misread field)
- Agreement = high confidence in the result
- Disagreement surfaces ambiguity, flaky conditions, or incorrect test methodology
- Prevents single-point-of-failure in automated testing
- Mimics real QA practice of independent verification

## Adapting for Your Project

| Placeholder | Description | Example |
|-------------|-------------|---------|
| `<project>` | Short project name | `jw-fixture`, `coach-api` |
| `<feature>` | What's being tested | `User auth flow`, `Fixture v3` |
| `<path>` | Report output directory | `claude/projects/gh_123/` |
| Test access | How testers query the system | SSH+mongosh, curl, psql |

## Example Configurations

### MongoDB on VM (via SSM)

```
## How to Test

SSH into VM and query Docker MongoDB:
  ssh -i ~/.ssh/dev-key.pem \
    -o "ProxyCommand aws ssm start-session --target <id> ..." \
    ubuntu@<id> \
    'docker exec <container> mongosh --quiet <db> --eval "QUERY"'
```

### PostgreSQL (local Docker)

```
## How to Test

Query via Docker:
  docker exec <container> psql -U postgres <db> -c "QUERY"
```

### REST API

```
## How to Test

Query via curl:
  curl -s -H "Authorization: Bearer $TOKEN" https://<host>/api/endpoint | jq .
```
