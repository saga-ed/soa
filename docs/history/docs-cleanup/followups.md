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

## `gh_214/README.md`'s `../multi/` cross-reference — outlives `multi/`'s Phase B removal

`gh_214/README.md` (formerly `CLAUDE.md`, moved in Phase A) names `../multi/`
as a cross-reference under "Cross-references" — the file's own text said
`../multi-synthetic-dev/`, a stale directory name fixed to the real one
during the Phase A move. D9.2 (Phase B) removes `multi/` as a non-initiative
with "nothing cites it" — that verdict was written before this reference was
found. Phase B's `multi/` removal should also drop or repoint this line.

## `docs/promotion-pipeline.md` — never written, cited from 3 shell scripts

`tools/synthetic-dev/{capture-local,capture-sandbox}.sh` and `up.sh:417`
comment-cite a doc that was never written (§0/§8 of the doc-state survey).
Resolution depends on D9.6's cluster-merge decision (author vs. drop);
Phase A leaves these 3 `code-doc-refs` findings as-is.
