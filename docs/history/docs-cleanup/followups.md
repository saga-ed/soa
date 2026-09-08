# docs-cleanup — deferred items

Not fixed in Phase A. Each needs a decision, a later phase's scope, or the
user's own tracking issue — not a Phase A doc-only edit.

## `soa_75/decisions/d-consumer-resilience.md` and `d-preview-deploy-isolation.md` — missing, no tracking issue

Per D9.5: both decision files are cited from live production code with no
deletion record and no fragment findable anywhere in the repo — see
`docs/history/soa_75/README.md#missing-decisions` for citers and detail.
This program records the gap; it doesn't file a GitHub issue on the user's
behalf. Citer comment updates (`connection-manager.ts:70` and the 2 bare
citers in `event-outbox`/`event-envelope`) are Phase D scope, not Phase A.

## `claude/projects/multi/` — wrongly removed in Phase B, restored

D9.1's decision doc framed `multi/` as uncited and slated it for Phase C
removal; Phase B's removal commit (`ff92faa5`) acted on that premise early,
`git rm`-ing it alongside the other dead root-level files, and dropped
`gh_214/README.md`'s `../multi/` cross-reference bullet in the same commit
on the reasoning that no replacement target would exist.

A fact-check pass (`so-phaseA-factcheck.md`) found the premise wrong:
`gh_214/research/06-multi-instance-analysis.md` cites the stale name
`multi-synthetic-dev` as live prior art under its own "Cross-references"
heading plus 3 inline prose mentions, and
`gh_214/research/01-synthetic-dev-inventory.md:105` names it too — `gh_214`
is OPEN, so D9.7's carve-out applies and `multi/` cannot be removed.
Corrected in a follow-up commit: `claude/projects/multi/` restored (2
files, unchanged content), the stale `multi-synthetic-dev` name fixed to
`multi` in both research files (dropping the `~/dev/soa/` prefix on the
one absolute-path occurrence), and `gh_214/README.md`'s `../multi/`
cross-reference bullet restored. `multi/` stays live; Phase C moves it to
`docs/history/multi/` with a banner (Status: CLOSED, "prior-art reference
cited by gh_214") instead of deleting it.

## `docs/promotion-pipeline.md` — never written, cited from 3 shell scripts

`tools/synthetic-dev/{capture-local,capture-sandbox}.sh` and `up.sh:417`
comment-cite a doc that was never written (§0/§8 of the doc-state survey).
This is a distinct missing-doc from D9.6's `npm-registry-publishing.md`
(package-publishing cluster) even though both share an "author vs. drop"
shape; D9.6 landed (`0ff06ec8`) deciding not to author
`npm-registry-publishing.md`, which settles that doc but not this one —
`promotion-pipeline.md`'s citers are separate call sites with their own
content requirement. The decision doc places this cluster's citation fixes
in Phase D (comments), not Phase A/B; these 3 `code-doc-refs` findings stay
as-is until then.

## `memory-bank/` — wrongly removed in Phase B, restored

D9.1's citation sweep (Phase B, pre-removal HEAD `8e519e29`) found the
decision doc's "nothing cites it live" framing for `memory-bank/`
incomplete: 6 of the 8 `.cursor/rules/*.mdc` files
(`code-organization`, `inversify`, `memory-bank`, `naming-conventions`,
`turborepo`, `unit-testing`) each tell Cursor to "always read and apply" a
specific `memory-bank/*.md` file (`memory-bank/unit-testing.md`,
`memory-bank/inversify.md`, etc., plus `memory-bank.mdc`'s own generic
"Cursor Memory Bank" convention description), and
`docs/history/gh_t54/sources/testing/README.md:132` separately points at
`/memory-bank/testing/` as "Additional testing prompts and strategies" — a
citer the original sweep also missed. This got recorded at the time as an
accepted gap (Cursor-tool config, treated as outside the
`.claude/rules/`/`docs/`/`CLAUDE.md` hierarchy this initiative scopes to)
rather than acted on.

Corrected: a cited file is never removed regardless of who or what cites it
— Cursor config counts. `memory-bank/` restored (22 files, unchanged
content) along with `docs/overview.md`'s repo-structure bullet naming it.
`human-notes/` (4 files) stays removed — re-swept the whole repo plus
`.cursor/`, no citer found anywhere (only this program's own decision-doc
prose mentions it).
