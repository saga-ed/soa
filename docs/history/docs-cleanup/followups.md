# docs-cleanup — deferred items

Not fixed in Phase A. Each needs a decision, a later phase's scope, or the
user's own tracking issue — not a Phase A doc-only edit.

## `fact-eval.py` doesn't sandbox `Read`/`Glob` to the worktree under test — program-level gap

Every state's eval run (baseline through final; see `eval/README.md`
Outcome section) shows a rising share of runs (35% baseline → 55% final)
issuing an absolute `/home/spaul/dev/<repo>/...` path that resolves outside
the worktree being scored, into the shared main checkout or another
worktree — whichever happens to exist on disk at run time. Raw
`total_tokens`/`num_turns` deltas across states are unreliable while this
holds; only clean-run (in-worktree-only) subsets are state-comparable. Fix:
either restrict `Read`/`Glob` to `--repo` inside `fact-eval.py`, or refresh
the shared main checkout to match each state before scoring it. Tracked as
claude-plugins PR #146 (documentation-system v5 plugin).

## `soa_75/decisions/d-consumer-resilience.md` and `d-preview-deploy-isolation.md` — missing, no tracking issue

Per D9.5: both decision files are cited from live production code with no
deletion record and no fragment findable anywhere in the repo — see
`docs/history/soa_75/README.md#missing-decisions` for citers and detail.
This program records the gap; it doesn't file a GitHub issue on the user's
behalf.

Phase C's cross-repo citer sweep found this citer list was incomplete:
`packages/node/observability/README.md:54` also names
`d-consumer-resilience.md` (D9.5's own analysis counted only
`event-consumer/README.md` ×2, `rabbitmq/README.md`, and
`connection-manager.ts:70`). `d-preview-deploy-isolation.md` has bare
citers outside `soa` entirely, in two sibling repos: `rostering`'s
`apps/node/iam-api/src/inversify.config.ts:377`, and `program-hub`'s
`apps/node/content-api/src/inversify.config.ts:84`,
`apps/node/programs-api/src/inversify.config.ts:245`, and
`apps/node/scheduling-api/src/inversify.config.ts:95` — 4 additional
citers beyond the 2 D9.5 scoped.

Phase D fixed every citer this repo owns: `connection-manager.ts:70`, the
2 bare citers in `event-outbox`/`event-envelope`, and
`observability/README.md:54` (this last one wasn't in D9.5's original
count) all now point at `soa_75/README.md#missing-decisions` instead of a
decision doc that doesn't exist. The 4 cross-repo citers in `rostering`
and `program-hub` are still unfixed — out of this program's per-repo
scope; each repo's own docs-cleanup pass (or a user-filed tracking issue)
owns that fix.

## `project-kit` plugin's `/new` skill still emits `claude/projects/gh_<issue>` — different repo, undermines the migration going forward

`claude-plugins/plugins/project-kit/skills/new/SKILL.md`,
`references/naming-contract.md`, and `references/configuration.md` (all in
the `claude-plugins` repo, outside this 7-repo docs-cleanup program's
scope) still name `claude/projects/gh_<issue>/` as the layout a new
initiative gets scaffolded into. Any new initiative created with `/new`
after this program lands would recreate the layout Phase C just retired
in every repo it touches, silently reopening the problem. Not fixed here —
belongs to whoever owns `project-kit`.

## `~/dev/sds-fixture/claude/projects/sds_80/phase-2/soa-infra-alignment.md` — stale wrong-repo-name reference

Already flagged as **Unresolvable** in
`docs/history/docs-cleanup/research/01-doc-state.md` (§ citer sweep):
`infra/compose/projects/saga-mesh/README.md:42` names a `sds-fixture` repo
that doesn't exist locally under `~/dev/` and a filename not present in
`student-data-system`'s actual `sds_80/phase-2/` either — likely an old
name for a repo later merged or renamed, plus a personal-path prefix. Not
part of D9's fix list; tracked here only so it isn't independently
rediscovered as new.

## `docs/express-api-guide.md` and `docs/library-guide.md` — orphaned and stale, not relinked

Both lost their only citer (`docs/quickstart.md`) in the D9.6 onboarding
merge and are unreachable from any doc. Attempted to relink both from
`docs/GETTING-STARTED.md`'s "Further reading," but verification against
current code found both stale on the build/test tooling they document,
not just orphaned:

- Both guides' "Unit Testing" section says "Use Jest," with
  `jest.config.cjs`/`ts-jest`/`@types/jest`. Zero packages or apps in the
  repo use Jest (`grep -rl '"jest"' apps/node/*/package.json
  packages/node/*/package.json` = no hits); all use `vitest run`
  (confirmed on 20+ `packages/node/*/package.json` and every sampled
  `apps/node/*/package.json`), matching `.claude/rules/testing-node.md`'s
  documented convention.
- `library-guide.md`'s "Build Configuration" section says "Use bunchee."
  Checked every `packages/{node,core,web}/*/package.json`'s `build`
  script: 0 of 34 use bunchee: the standard is `tsup` (CLI-style
  packages use `tsc`/`tsc && oclif manifest` instead). `bunchee` appears
  only in the repo-root `package.json`, not any package's own script.

Not relinked — following D9's "reference misfiled as history gets
promoted, not linked back in stale" principle in reverse: these were
never archived, but relinking a doc whose core technical claim is wrong
would just re-orphan-in-place. Rewriting both guides to match current
tooling is a real edit, not a doc-cleanup citer fix, so it's left for
whoever owns onboarding docs next — this program's Phase A/D scope is
comments and citations, not content correctness of files nothing else
in the repo depends on.

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

## `docs/promotion-pipeline.md` — never written, cited from 3 shell scripts (resolved Phase D)

`tools/synthetic-dev/{capture-local,capture-sandbox}.sh` and `up.sh:417`
comment-cited a doc that was never written (§0/§8 of the doc-state survey).
This is a distinct missing-doc from D9.6's `npm-registry-publishing.md`
(package-publishing cluster) even though both share an "author vs. drop"
shape; D9.6 landed (`0ff06ec8`) deciding not to author
`npm-registry-publishing.md`, which settles that doc but not this one —
`promotion-pipeline.md`'s citers were separate call sites with their own
content requirement.

Phase D resolved it the same way: no fragment of `promotion-pipeline.md`
exists anywhere in the repo to author it from, so the 3 dangling
references were dropped rather than the doc written. Each citer's
surrounding content (the "What this does NOT do" bullet lists,
`up.sh`'s `--workspace` manifest note) stayed intact — only the pointer
to the nonexistent doc came out.

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
