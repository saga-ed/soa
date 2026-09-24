# Candidate B authorization model (v1.2) — validated

The target OpenFGA model chosen by the authz bake-off (Candidate B: declarative
capability grants on a containment ladder), extended by the 2026-09-05 use-case
survey and the 2026-09-15 stakeholder-review rulings (D1-D8). Rulings and open policy
calls, and every existing decision it must cover, are tracked downstream in rostering's
`claude/authz_candidate_b_fit.md`, `claude/authz_decisions/model_v1_2_stakeholder_review.md`,
and `claude/authz_use_case_catalog.md` (not part of this repo).

This directory is **not** the live model — `../model.fga` (this package's canonical
`model.fga`, one directory up) is still what ships and is versioned with `src/types.ts`.
Promoting Candidate B to replace it is a deliberate follow-up step, gated on the
prerequisites tracked in the fit doc referenced above, and is out of scope here.

## Files
- `model.fga` — the model. `fga model validate --file model.fga` must pass.
- `balt.fga.yaml` — the bake-off's district "balt" fixture + the six use cases + edge cases +
  check/list-objects parity.
- `contextual.fga.yaml` — rostering D9: an unmaterialized session resolved only through
  per-check contextual tuples (the CLI expresses these as a per-test `tuples:` list).
- `extensions.fga.yaml` — every relation the survey added (observers, QTF, participants,
  ad-hoc rooms, district/staff capabilities, coach_progress, schools, roles, D1-D8 v1.2 additions).
- `roles.fga.yaml` — D1 role-object mechanics: one assignee tuple granting every capability a
  district persona holds, the district-scoping invariant, and the direct `[user]` exception path.
- `test.sh` — runs all of the above; also exercised in CI (see below).

## Running
```sh
# the fga CLI (https://github.com/openfga/cli). GitHub downloads may be blocked; building from
# source through the Go module proxy works:
#   GOTOOLCHAIN=auto go install github.com/openfga/cli/cmd/fga@latest
./test.sh            # uses $FGA if set, else `fga` on PATH
```
`fga model test` runs against an embedded in-memory server — no store, no docker required if the
`fga` binary is on `PATH`. If it isn't, run the CLI via the official Docker image instead — `$FGA`
accepts a multi-word command (word-split internally), so point it at this directory with an
**absolute path** (a relative `$PWD`-based mount only works if the shell's cwd is already this
directory):
```sh
FGA="docker run --rm -v /absolute/path/to/candidate-b:/w -w /w openfga/cli" ./test.sh
```

## Conventions
- Capability-named relations (D1), not role nouns: every capability a persona grants is its own
  directly-assignable relation (e.g. `can_edit`, `can_coordinate`, `qtf_access`,
  `can_observe_sessions`), accepting `[user]` (a genuinely program/pod/school-scoped exception
  grant) or `[user, role#assignee]` (a district-scoped persona, see `type role`). Every `can_*`
  below district is `capability here OR capability from parent_*`. No `group` walk in the
  resource tree, no `user:*` wildcard.
- `session.can_view_own_hosted` is the model's one intersection (`host and affiliate from
  parent_pod`, D6) — exercised by both `check` and `list_objects` paths in the fixtures (SOA-07).
- `host`/`participant`/`observer`/`subject` on `session` are contextual until a row
  materializes, then frozen by `sessions.session.materialized` through authz-sync (sole writer).
- Object ids: `district:<iam Group.id>`, `program:<Program.id>`, `school:<iam school Group.id>`,
  `pod:<Pod.id>`, `session:<occurrence id>`, `coach_progress:<userId>`, `role:<district>/<name>`.
  Ids may not contain `:`.
