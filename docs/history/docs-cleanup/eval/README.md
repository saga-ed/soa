# Fact-discovery eval — soa

`questions.json` is the visible half of a 32-question set (fact / pattern /
negative); the held-out half is committed alongside it as
`questions-heldout.json` after the cleanup lands. Runner and format: the
documentation-system plugin's `scripts/fact-eval.py`; method and metric
definitions: student-data-system `claude/projects/docs-cleanup/eval/README.md`.
Runs go in `runs/` as `<date>-<state>-<half>.jsonl`, one `.summary.json`
alongside each.

Every expected answer was verified against code/config, then independently
fact-checked (3 of 32 corrected before the baseline: a substring-fragile path
token, a false 'zero hits' claim on a negative, a wrong line citation).

## Baseline table

TBD.
