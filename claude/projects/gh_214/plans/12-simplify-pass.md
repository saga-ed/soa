# M15 — Simplify pass over saga-stack-cli (soa#214, tracker #221)

A deliberate simplification milestone after the M0–M14 build-out: the package is
~19.8k source lines + ~14k test lines with 869 tests green, and it accumulated the
kind of debt fast milestones do — duplicated context builders, dead option surface,
quadruplicated test harnesses, and prose that already drifted from the code. This
plan is a **zero-behavior-change** pass: every item is a deletion, a dedup, or a
mechanical move; anything that would alter observable behavior (beyond fixing
already-wrong help text) is out of scope.

Grounded by three read-only scouts over branch `gh_214-m13a-set-store` (PR #236):
duplication/dead-surface, structure hotspots, and test-suite consolidation. Size
inventory: `stack-api.ts` 1050, `e2e-orchestrate.ts` 993, `base-command.ts` 966
(~35% JSDoc), `up.ts` 714.

**Negative finding worth recording:** nothing is vestigial on the delegate path.
There is no `--legacy` flag anywhere; `runScript`/`ScriptPlan`/`resolveScript` still
drive the live `check-e2e.sh` + overlay/tunnel vendored scripts, and the Phase-2
decoupling (b15a181) already deleted the dead mappers. Don't go hunting there.

---

## 1. Production-code candidates (ranked)

### P1 — Dead surface + drift fixes (all S, independent, do first)

| Item | Evidence | Risk |
|---|---|---|
| Delete `onlyStages`/STAGE_ONLY | `core/flow/resolve.ts:102,123-135,215-217` — no command wires it, **zero tests exercise it**, quirky semantics (matches id/project but not phase) already bit the M14 design review | none — pure deletion |
| Delete manifest `flowId` | `core/snapshot/manifest.ts:145` — write-only (`checkpoint-store.ts:122`), superseded by the M14 `flow` block; zod strips unknown keys so on-disk manifests stay readable | low |
| Fix BOTH guard-message prose lists | `shared-flags.ts:85-90,100-103` — **already drifted**: `e2e list` is slot+set-aware (M13) and missing from both lists. Fix: stop enumerating commands in prose ("the slot-aware lifecycle set — see `--help`") so it *can't* drift again | low |
| Delete `UpOpts` | `stack-api.ts:373-377` — empty options bag (`{ readonly _?: never }`), never read | none |
| Drop redundant `soa?` from `WorkspaceFlags` | `base-command.ts:101-104` — `Partial<Record<RepoKey,…>>` already includes it | none |
| Memoize `e2e list`'s `ckpt()` | `commands/e2e/list.ts:65-84` — each stage's checkpoint manifest is read from DISK twice (once for JSON at :104, once for text at :119) | very low |
| Single `computeEnv` in `describeResolved` | `e2e-orchestrate.ts:496` + `:537` compute it twice; pure + cheap but redundant | none |

### P2 — ONE repo-context builder + one kebab vocabulary (M — the anchor)

Seven sites run the identical `for (kebab of REPO_ENV_VAR)` loop; behavior is
identical everywhere (the only deltas are cosmetic typing guards). Collapse:

- **Shape A (ScriptContext)**: `base-command.scriptContextFromFlags` becomes a thin
  wrapper over ONE shared builder (natural home `runtime/repos.ts`, next to
  `buildRepoEnv`); repoint `status.ts repoContextFromFlags` (used by
  status/verify/overlay/bootstrap), `e2e-orchestrate buildStackContext`'s inline
  loop, and `down.ts tearMeshDown`'s hand-rolled SOA-only ctx.
- **Shape B (child env)**: `overlayRepoEnv` (`e2e-orchestrate.ts:164-173`) calls
  `buildRepoEnv` instead of re-looping; `runScript`'s inline loop reuses the shared
  pieces.
- **Vocabulary**: retype `REPO_ENV_VAR` as `Record<RepoKey, ManifestRepoKey>` —
  deletes the `as ManifestRepoKey` cast at all six conversion sites; move the kebab
  key list to core (where `SET_REPO_KEYS` already lives for purity), import it from
  `runtime/repos.ts`, and retire the lockstep unit test (3 parallel lists → 2, one
  compiler-checked).

Blast radius: base-command/status/e2e-orchestrate/down + repos/worktree-sets + the
`repoContextFromFlags` direct tests. Risk: low-moderate — behavior identical,
compiler-checked; the risk is test churn only.

### P3 — Structure splits (S/M each, mechanical)

| Item | Evidence | Size |
|---|---|---|
| e2e-orchestrate checkpoint exec → own module | `restoreCheckpoint`+`bakeStageCheckpoint` (`:875-993`, ~120 lines, private, unspied) — pure move, shrinks the 993-line file ~12% | S |
| `describeResolved` + dry-run projection → own module | `:434-583` (~150 lines), 100% pure, one importer | S/M |
| `up.ts` shared sandbox-prune | duplicated math `:342-350` vs `:451-459`; optionally split dry-run/native halves | M |
| Runtime-assembler dedup (**elective**) | `buildNativeRuntime` vs `buildStackContext` near-clones — **already TODO'd in code** (`e2e-orchestrate.ts:18-19`); two divergent tails (overlays vs prep-at-every-slot) make this the riskiest item — extract only the shared repoRoots/launchContext core | M |

### P4 — Comment diet (S/M, comments-only; **flag, not mandate** — skelly's call)

- The ~24 seam getters repeat the same "tests spy this on the prototype …
  mirroring how getRunner/… are mocked" tail ~15×: one file-header paragraph on the
  pattern + a terse one-liner each. base-command.ts is ~35% JSDoc today.
- `up.sh:NNNN` line references are archaeological post-decoupling (densest:
  `prep.ts` ×10, `seed/profiles.ts` ×7, `reset.ts` ×6): **keep the behavioral
  rationale, drop the line numbers** — nothing in-repo can verify them and they rot
  silently. Exceptions that carry real contracts stay (e.g. the exit-code contract
  note in stack-api).

## 2. Test-suite candidates (ranked; helpers verified safe)

`src/__tests__/helpers/` is collectable by neither vitest (`*.{unit,int}.test.ts`
globs only) nor the build (`__tests__` excluded). Estimated net deletion:
**~500–600 copied lines** across 9 files.

| # | What | Copies | Proposal | Risk note |
|---|---|---|---|---|
| T1 | env save/restore + temp `SAGA_MESH_SNAPSHOTS_DIR` | 4 suites × 3 shapes (+ the M13 real-`~/.saga-mesh` HOME hazard re-implemented per file) | `helpers/env.ts`: `useTempSnapshotsDir()`, `saveEnv/restoreEnv` — ONE place enforces the HOME redirect | low; do first |
| T2 | `SnapshotIO` fake | 2 (snapshot.int, checkpoint.int) — deliberate `readSchemaRev` divergence | `helpers/snapshot-io.ts`: `fakeSnapshotIO({schemaRev, …})` — the divergence becomes a documented option | low |
| T3 | `installSeams()` fake battery | 4 files, ~370 lines, byte-identical runner/pgProbe core, **already drifting** (`prepFresh` true in 2, false in 2 — a silent fork) | `helpers/seams.ts`: `installCoreSeams({pidBase, prepFresh, launchFail, …})`; up-native/checkpoint compose extras on top. Keep `prepFresh` explicit per call site — a shared default could mask a regression | low-med |
| T4 | set-command spy trio + probe classes + store fixtures | spyStore/spyGit/spyFresh/spyActive ×2–3; `{version:1,sets:{…}}` blob ×13/4/1 (+unit files) | `helpers/set-fakes.ts` + parameterized store builders (fixtures encode INTENTIONAL scenario deltas — keep expressive) | low-med |
| T5 | exact Playwright argv arrays + dry-run prose (**partial**) | argv array ×2, dry-run string ×2 | an argv **builder** for variant cases only — **keep one fully-literal golden anchor** (run.int happy path); never derive expected text from production code | med — the dup is partly intentional protection |

Explicitly NOT worth consolidating: PKG_ROOT/WS one-liners (17 files, trivial),
slot-port literals in port-planning unit tests (the literal IS the assertion),
`'==> '` prose asserts (all 8 in one file).

## 3. DO NOT TOUCH (load-bearing complexity)

- **The 21 seam getters stay on `BaseCommand.prototype`** — 13 int-test files spy
  `prototype.getX`; the seam architecture is the test strategy, not over-abstraction.
- **Slot-0 byte-identity** (`derive-instance`, launch-plan slot tests, stack-api's
  ONE slot-injection site, frontend `--port` append).
- **`playwrightEnv` ordering** (dates → dateOverrides → service URLs; split-brain guard).
- **`BaseCommand.parse` ordering** (set injection BEFORE the slot guard).
- The delegate/wrapper path (live: check-e2e/overlay/tunnel).

## 4. Milestones

| Milestone | Contents | Effort | Gate |
|---|---|---|---|
| **M15-A — deletions + drift fixes (do first)** | All of P1 | S | suite green, message-text tests updated; net-negative diff |
| **M15-B — one builder, one vocabulary** | P2 | M | suite green; `repoContextFromFlags` tests repointed; no `as ManifestRepoKey` casts remain |
| **M15-C — test harness consolidation** | T1→T2→T3→T4, T5 partial | M | test LOC drops ~500+; every suite green after EACH rank (land per-rank commits) |
| **M15-D — splits + comment diet (elective)** | P3 (assembler dedup last/optional) + P4 per skelly's appetite | M | pure moves: green suite + no export-surface change (barrels updated) |

**Sequencing note:** land M15 as its own PR *after* #236 merges — mixing a
simplify sweep into the feature PR would bloat an already 11-commit review. The
plan document rides #236; the work waits for the merge.

## 5. Validation

- The full suite stays green after every commit (869 baseline; count may shift
  only where dead surface had tests — it doesn't, per the scouts).
- `git diff --stat` is net-negative for M15-A/B/C (target: −700+ lines total).
- M15-A/B behavior-invariance: `node bin/dev.js e2e run … --dry-run` and
  `ss set check` outputs byte-identical before/after (except the two corrected
  guard messages); a slot-1 `--dry-run` spot-check confirms port/env output
  unchanged.
- T3 lands with the `prepFresh` fork made EXPLICIT (both values still exercised).

## 6. Open questions for skelly

1. **Comment diet appetite (P4)**: trim the seam-getter JSDoc + drop `up.sh` line
   numbers (keeping rationale), or leave the archaeology in place? Plan recommends
   trimming; it's ~300 lines of pure prose.
2. **Assembler dedup (P3 last item)**: take the already-TODO'd
   `buildNativeRuntime`/`buildStackContext` merge in M15-D, or defer to the next
   feature that touches both? Plan recommends deferring unless M15-D is otherwise
   cheap — it's the only item with real divergence risk.
3. Confirm the sequencing call: M15 as a follow-up PR after #236 merges.
