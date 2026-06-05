# 04 — Step-1 parity audit: scenario base vs `db:seed` base

> **The gating artifact for the convergence** (see `03-convergence-analysis.md` R2).
> Question: does each service's `db:seed` cover everything the scenario
> runner seeds today, *per district* — so synthetic-dev's base can be
> re-pointed at `db:seed` without losing login/admin parity?
>
> Method: two read-only code audits (2026-06-04) of the actual seed source,
> not the docs. Every claim below is traceable to a file:line in the agent
> findings. Repo state: `rostering` @ `main` (`f173886`), `program-hub` @
> `local/integration` (`6bd88f2`).
>
> **Verdict: ONE real gap (per-district admin personas), narrowly scoped to
> `@saga-ed/iam-seed-ids`. Everything else, `db:seed` already meets or
> exceeds the scenario.** The convergence is lower-risk than `03` feared.

---

## Headline result

| Domain | Scenario (Path A) | `db:seed` (Path B) | Parity? |
|---|---|---|---|
| Districts (5) | ✅ all 5 | ✅ all 5, deterministic UUIDs | **B ≥ A** |
| Schools (13) | ✅ | ✅ (+1 manual + 3 CSV shadow groups) | **B ≥ A** |
| Sections (28) | ✅ | ✅ (+1 manual Algebra I) | **B ≥ A** |
| Roster (168 students + 22 tutors) | ✅ | ✅ same names/sections | **B = A** |
| Named login-able users | 6 | **15** (6 canonical + 9 demo) | **B ≥ A** |
| Password auth (login-able) | ✅ all named | ✅ all 15 (argon2id, `password123`) | **B ≥ A** |
| **Per-district admin personas** | ✅ **all 5 districts** | ❌ **`seed` only** | **A > B — THE GAP** |
| Roster memberships | district+school+section (3/person) | district+section (2/person) | **A > B (minor)** |
| Programs (9) | ✅ | ✅ deterministic | **B = A** |
| Periods (17) | ✅ | ✅ deterministic | **B = A** |
| Enrollment config (school/section/period mappings) | ✅ | ✅ same shape, deterministic | **B = A** |
| Schedules / RRULE / CalendarEvent | ❌ none | ✅ scheduling-api db:seed | **B > A** |
| Sessions / Pods / Slots (Connect Demo) | ❌ none | ✅ `seedConnectDemo` | **B > A** |
| Content (12 items) | ❌ none | ✅ content-api db:seed | **B > A** |
| **ID determinism** | ❌ server-minted per run | ✅ `uuidv5(slug)` offline | **B > A — the whole point** |

**The big realization:** for the **program-hub side, `db:seed` is a strict
superset of the scenario** — it produces everything the scenario does
(programs, periods, enrollment config) *plus* scheduling, sessions, and
content the scenario never touches, all deterministically and offline. The
scenario's *only* unique contributions are on the **iam side**: (1)
per-district admin personas, and (2) an extra school-level membership row
per roster person. Gap (1) is the gate; gap (2) is cosmetic.

---

## The one real gap — per-district admin personas (R2 confirmed)

**This is exactly the follow-up Seth flagged, and it is real.**

### Scenario (Path A) creates admin personas for ALL 5 districts
`rostering/scripts/scenarios/src/program-hub.ts:431-454` — for **every**
district it creates group-scoped `admin` + `tutor` + `student` personas
(bound to ADMIN/TUTOR/STUDENT roles from `personas.listRoles`). Dev users
mapped into a district receive that district's admin persona
(`:507-517`). So `many`→metro-admin, `new`→oakdale+frontier-admin,
`frontier`→frontier-admin, `multi`→riverside-admin all work.

### `db:seed` (Path B) creates an admin persona for `seed` ONLY
`rostering/packages/node/iam-db/prisma/seed.ts:285-296`:
- `personaAdminDistrict` (admin, **seed** district) ✅
- `personaAdminLincoln` (admin, **school-level**, Lincoln — still inside seed) ✅
- riverside / metro / oakdale → **student + tutor personas only, NO admin**
- frontier → **no personas at all**

And the catalog users land in their districts *without* an admin persona:
`seed.ts:558-566` sets `personaId: slug === 'seed' ? personaAdminDistrict : null`.
So `multi`(riverside), `many`(metro), `new`(oakdale), `frontier`(frontier)
all get `personaId = null` — they can authenticate but have **no district
admin role**.

### Per-district admin matrix

| District | Scenario admin? | `db:seed` admin? | Catalog user there | Admin under db:seed? |
|---|:--:|:--:|---|:--:|
| `seed` | ✅ | ✅ | `dev` (+demo users) | ✅ |
| `riverside` | ✅ | ❌ | `multi` | ❌ |
| `metro` | ✅ | ❌ | `many` ← *recommended walkthrough user* | ❌ |
| `oakdale` | ✅ | ❌ | `new` | ❌ |
| `frontier` | ✅ | ❌ | `frontier` | ❌ |

**Why it's the gate:** the onboarding doc recommends `many@saga.org`
(metro, "richest — many programs") as the happy-path walkthrough user.
Under `db:seed` today, `many` logs in with **no admin persona** → a
degraded/empty admin experience in saga-dash. Flipping synthetic-dev's
default to `db:seed` before closing this would *regress* every
non-`seed`-district persona.

### The fix is small and lives in the right place
Add per-district admin personas to the iam seed so `db:seed` mints an
`admin` persona for riverside/metro/oakdale/frontier (and binds the
catalog user in each district to it). This is a **`@saga-ed/iam-seed-ids`
+ `iam-db/prisma/seed.ts` change** — it belongs in the package/contract,
not in synthetic-dev. Once landed, it flows to local **and** preview/CI
for free (the whole seed-ids payoff). Estimated: small, additive, drift-
test-guarded.

---

## Secondary gap — roster school-level memberships (cosmetic)

Scenario gives each roster person 3 membership rows
(district+school+section, `program-hub.ts:622-663`); `db:seed` gives 2
(district+section, `seed.ts:594-602`). This is most of why the membership
counts differ (~593 scenario vs ~413 db:seed). Functionally minor —
section membership already implies the school via the section's parent —
but if any saga-dash query filters roster by *school* membership directly,
it would see fewer rows. **Confirm whether any consumer reads school-level
roster membership; if not, ignore. If yes, add the row in `db:seed`.**

---

## Correction to a premise carried in `03` and memory — the dev user

The audit corrects the "`AUTH_DEVUSERID = f0000004-…-beef` is the
scenario's dev user" framing:

- The scenario assigns **no fixed dev-user ID** — `dev-user`/`dev@saga.org`
  gets a **server-random UUID** each run (`builders.ts:171`).
- `f0000004-0000-4000-8000-00000000beef` belongs to a **separate**
  standalone seeder, `rostering/packages/node/iam-db/src/seed-dev-user.ts`
  (`DEV_USER_ID`, email **dev@example.org**, username `devuser`) — which
  synthetic-dev's `up.sh` runs *in addition to* the scenario (drift #5).
- `db:seed` itself has **two** dev identities: the canonical `dev` =
  `userId('dev')` = `1e2ca0d8-…-1186` (dev@saga.org) **and** a hardcoded
  demo `devuser` = `f0000004-…-009` (dev@example.org).

So synthetic-dev *today* already juggles two "dev" identities (scenario's
random `dev@saga.org` + the `…beef` `dev@example.org` fallback). Seth's
proposed change 3 (standardize on `userId('dev')` = `1e2ca0d8-…`) actually
*removes* this existing ambiguity — a cleaner win than `03` credited.
**Email-based devLogin (`dev@saga.org`/`password123`) keeps working** under
`db:seed` because the canonical `dev` user carries that email + password
auth.

---

## Username divergence (low risk, worth noting)

The two paths use different **usernames** for the named users (emails
mostly match):

| email | scenario username | db:seed (catalog) username |
|---|---|---|
| dev@saga.org | `dev-user` | `dev` |
| multi@saga.org | `user-multi-district` | `multi` |
| many@saga.org | `user-many-programs` | `many` |
| new@saga.org | `user-new-district` | `new` |
| frontier@saga.org | `user-empty-district` | `frontier` |
| none@saga.org | `user-no-district` | `none` |

Anything keyed on **username** breaks across the flip; anything keyed on
**email** or **derived UUID** is fine. `./up.sh --login` uses email
devLogin, so it's unaffected. Audit saga-dash for any hardcoded username
before flipping (likely none — it authenticates via tRPC whoami).

---

## Revised base/journey picture (feeds d1.1)

The audit overturns the convergence doc's assumption that scenarios are a
**journey layer on top of** the base. **Today they are not** — the
program-hub scenario creates *base* data (programs, periods, enrollment
config) that `db:seed` also creates, just non-deterministically. There is
**no journey-only data today**: neither path creates per-student
enrollment rows, and only `db:seed` creates sessions/schedules/content.

Implication for the layered model:
- The "journey layer" Seth describes (enrollments, schedules, sessions,
  attendance flows on top of a stable base) is **aspirational** — it
  mostly **doesn't exist yet** in either path.
- Converging the base to `db:seed` therefore **loses essentially nothing**
  on the program side (db:seed ⊇ scenario) and **gains** scheduling +
  sessions + content + determinism.
- The scenario runner's residual value, post-convergence, is: (a) the
  per-district admin personas *until* they move into `db:seed` (then even
  that goes away), and (b) a future home for genuinely dynamic journey
  data that nobody has written yet.

This means the convergence is closer to **"adopt the db:seed superset and
backfill the one persona gap"** than to **"carefully split base from
journey."** The split is easy because the journey set is nearly empty.

---

## Bottom line / what unblocks the flip

**One precondition gates flipping synthetic-dev's default to `db:seed`:**

> Add per-district admin personas (riverside / metro / oakdale / frontier)
> to `@saga-ed/iam-seed-ids` + `iam-db/prisma/seed.ts`, and bind each
> district's catalog user to its admin persona.

Everything else is parity-or-better. Two minor follow-ups (school-level
roster membership; username references in saga-dash) are confirm-then-
ignore-or-patch. The dev-user change is a simplification, not a risk.

See `../decisions/d1.1-base-journey-split.md` for the decision this audit
feeds.

## Source

- IAM audit (Path A vs B): agent over `~/dev/rostering` —
  `scripts/scenarios/src/{program-hub,builders,run}.ts`,
  `packages/node/iam-db/prisma/seed.ts`,
  `packages/core/iam-seed-ids/src/{catalog,ids,roster,derive}.ts`,
  `packages/node/iam-db/src/seed-dev-user.ts`.
- Program audit (Path A vs B): agent over `~/dev/program-hub` —
  `scripts/scenarios/src/programs.ts`, `scripts/seed.sh`,
  `apps/node/{programs,scheduling,content}-api/src/prisma/seed*.ts`,
  `packages/core/{program,content}-seed-ids/src/{catalog,index}.ts`.
