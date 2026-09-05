# Candidate B authorization model (v1) — validated

The target OpenFGA model chosen by the authz bake-off (Candidate B: declarative
StaffAssignment roles on a containment ladder), extended by the 2026-09-05 use-case
survey. Rulings and open policy calls, and every existing decision it must cover, are
tracked downstream in rostering's `claude/authz_candidate_b_fit.md` and
`claude/authz_use_case_catalog.md` (not part of this repo).

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
  ad-hoc rooms, district/staff capabilities, coach_progress).
- `test.sh` — runs all of the above; also exercised in CI (see below).

## Running
```sh
# the fga CLI (https://github.com/openfga/cli). GitHub downloads may be blocked; building from
# source through the Go module proxy works:
#   GOTOOLCHAIN=auto go install github.com/openfga/cli/cmd/fga@latest
./test.sh            # uses $FGA if set, else `fga` on PATH
```
`fga model test` runs against an embedded in-memory server — no store, no docker.

## Conventions
- One directly-assignable role relation per type (`admin`, `ipm`, `coordinator`, `tutor`,
  `observer`, `qtf_access`); every `can_*` is `role or can_* from parent_*`. No `group`
  walk in the resource tree, no `user:*` wildcard, no intersections.
- `host`/`participant`/`observer`/`subject` on `session` are contextual until a row
  materializes, then frozen by `sessions.session.materialized` through authz-sync (sole writer).
- Object ids: `district:<iam Group.id>`, `program:<Program.id>`, `site:<ProgramSchoolMapping.id>`,
  `pod:<Pod.id>`, `session:<occurrence id>`, `coach_progress:<userId>`. Ids may not contain `:`.
