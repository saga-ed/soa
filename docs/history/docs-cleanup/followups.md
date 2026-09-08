# docs-cleanup — deferred items

Not fixed in Phase A. Each needs a decision, a later phase's scope, or the
user's own tracking issue — not a Phase A doc-only edit.

## `soa_75/decisions/d-consumer-resilience.md` and `d-preview-deploy-isolation.md` — missing, no tracking issue

Per D9.5: both decision files are cited from live production code with no
deletion record and no fragment findable anywhere in the repo — see
`claude/projects/soa_75/README.md#missing-decisions` for citers and detail.
This program records the gap; it doesn't file a GitHub issue on the user's
behalf. Citer comment updates (`connection-manager.ts:70` and the 2 bare
citers in `event-outbox`/`event-envelope`) are Phase D scope, not Phase A.

## `gh_214/README.md`'s `../multi/` cross-reference — resolved in Phase B

Dropped the `../multi/` bullet from `gh_214/README.md`'s "Cross-references"
section in the same commit that removed `claude/projects/multi/` (D9.2,
Phase B) — no replacement target exists, so the line was removed rather than
repointed.

## `docs/promotion-pipeline.md` — never written, cited from 3 shell scripts

`tools/synthetic-dev/{capture-local,capture-sandbox}.sh` and `up.sh:417`
comment-cite a doc that was never written (§0/§8 of the doc-state survey).
Resolution depends on D9.6's cluster-merge decision (author vs. drop);
Phase A leaves these 3 `code-doc-refs` findings as-is.

## `.cursor/rules/*.mdc` depend on the removed `memory-bank/` — not fixed

D9.1's citation sweep (Phase B) turned up 5 Cursor-IDE rule files that D9.1's
own "nothing else cites it live" framing missed: `.cursor/rules/{unit-testing,
code-organization,naming-conventions,inversify,turborepo}.mdc` each tell
Cursor to "always read and apply" a specific `memory-bank/*.md` file
(`memory-bank/unit-testing.md`, `memory-bank/inversify.md`, etc.) — all now
gone. `docs/overview.md`'s repo-structure listing (a current-tier doc) had
the same problem and was fixed in the same commit as the removal; the
`.mdc` files were left alone because they're Cursor-tool config outside the
`.claude/rules/`/`docs/`/`CLAUDE.md` hierarchy this initiative scopes to,
not because the dependency isn't real. Whoever still uses Cursor with this
repo should either restore the referenced content under `.claude/rules/` (if
still relevant) or delete the 5 `.mdc` files.
