# QA Cross-Validation Summary

**Feature:** <feature name>
**Date:** YYYY-MM-DD
**QA Lead:** <name>

---

## Test Plan Coverage

- **Section A**: N tests (categories: ...)
- **Section B**: N tests (categories: ...)
- **Total**: N tests

## Reports

| Report | Tester | Section | Pass | Fail | Warn |
|--------|--------|---------|------|------|------|
| First pass | Alpha | A | | | |
| First pass | Beta | B | | | |
| Swap | Alpha | B | | | |
| Swap | Beta | A | | | |

---

## Section A Agreement Matrix

| Test ID | Description | Alpha | Beta | Consensus | Action |
|---------|-------------|-------|------|-----------|--------|
| A1.1 | ... | PASS | PASS | CONFIRMED PASS | None |
| A1.2 | ... | WARN | PASS | RESOLVED PASS | [explanation] |

## Section B Agreement Matrix

| Test ID | Description | Alpha (swap) | Beta | Consensus | Action |
|---------|-------------|--------------|------|-----------|--------|
| B1.1 | ... | PASS | PASS | CONFIRMED PASS | None |
| B2.1 | ... | PASS | FAIL | RESOLVED PASS | [explanation] |

---

## Final Summary

| Category | Count |
|----------|-------|
| **CONFIRMED PASS** | N |
| **RESOLVED PASS** (disagreement resolved) | N |
| **CONFIRMED WARN** | N |
| **CONFIRMED FAIL** | N |
| **Unresolved Disagreements** | N |

---

## Remaining Work

### Confirmed Failures (fix required)

1. [ ] **Fix**: [test ID] - [description of confirmed failure]

### Disagreements (investigate)

1. [ ] **Investigate**: [test ID] - [description of disagreement, which tester was right]

### Warnings (decide)

1. [ ] **Decide**: [test ID] - [description of warning, whether it needs action]

### Retest After Fixes

1. [ ] **Retest**: [test IDs that need re-verification after fixes are applied]

---

## Cross-Validation Insights

[Document any valuable findings from the cross-validation process itself:
- Did one tester query a different data source that resolved the other's WARN?
- Did the swap catch a false positive from the first pass?
- Any methodology improvements for next time?]
