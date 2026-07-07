# Plan 16 — browsable flow worlds (hermetic flows seed their own viewer)

**Problem.** The `scheduling-topology` e2e flow builds its world in an isolated
Empty Org, entirely via API. The dash UI scopes program browsing to the
signed-in user's own districts (`groups.getByUser kind='district'` — no org
switcher), and the stock `dev@saga.org` only carries Seed District — so nobody
could manually inspect the flow's world in a browser.

**Proven facts (live debugging, 2026-07-07):**

- dev@saga.org's UI selector shows only Seed District programs.
- Adding a **bare** `group_membership` for dev into the org did NOT change the
  mint's district context.
- The CLI's `ss stack login` accepts arbitrary emails (M11) — it rides
  `auth.devLogin`, so anything devLogin-able is CLI-loggable.

**Goal.** The topology flow seeds ONE browsable admin user INSIDE its org —
fixed email `ab-topology-admin@saga.org` — so a human can

```bash
ss stack login ab-topology-admin@saga.org --slot 1 --browser
```

and see the program/sessions in the dash UI.

---

## Chosen authoring path (verified live on slot 1 before spec'ing)

All over the REAL iam-api tRPC surface, as the seeded org admin
(`empty@saga.org`) — the `journey/attendance-personas.e2e.test.ts` precedent.
On the stack lane the write gates (CSRF / janus `iam-admin` / FGA) all no-op,
so a bare `iam_session` cookie authorizes them.

1. **Probe** `auth.devLogin(ab-topology-admin@saga.org)` — a 200 means the
   user survives from a prior run against the same DB (reuse); a 401 means
   create. (Probe-first is load-bearing: `users.create` rejects a duplicate
   username with HTTP 500, not a typed CONFLICT.)
2. **Create** (miss only): `users.create { username, role:'ADMIN',
   profile.screenName, pii:{ email, nameFirst, nameLast } }`. The `pii.email`
   is what makes the user devLogin-able — the mint resolves email → user via
   the PII email-hash index.
3. **Membership**: `groups.addMembers { groupId: EMPTY_ORG_ID, members:
   [{ userId, personaId, source:'manual' }] }` where `personaId` is the
   **seeded Empty-Org ADMIN persona** (resolved via `personas.listForGroup`
   by `role==='ADMIN'`, not a hardcoded id). This mirrors empty@saga.org's own
   membership shape exactly: full dash admin bundle (44 permissions incl.
   `dash:view_sessions_tab` + `dash:view_admin_panel`). `addMembers` upserts ⇒
   idempotent on reuse.
4. **Assertions** (the flow's browsability stage, loud on regression):
   devLogin mints 200; `groups.getByUser kind='district'` includes the org
   (the dash selector source); the org's `getMyPermissions` entry carries the
   two nav permissions; `programs.list` **as the viewer** contains the program
   the run just built.

**Why this path** (vs alternatives considered):

- *Reuse the seeded persona, don't create one* — the Empty Org already seeds
  exactly one ADMIN persona (`#438` one-persona-per-role assumption); creating
  another would violate that assumption and drift from empty@'s shape.
- *Not the sis-api CSV path* — roster CSV creates students/tutors/staff, not
  org admins, and drags in materialized-view lag for no benefit.
- *Not a new iam-db seed* — the flow's org world is API-built by design
  (hermetic); the viewer belongs to the same world-building stage, and the
  flow asserting its own mint keeps the manual-inspection CL from rotting.
- *Not empty@saga.org as the documented viewer* — empty@ is the roster-CSV
  suite's mutable actor (deactivation sweeps etc.); a dedicated fixed identity
  keeps the browsing contract independent of other suites' churn.

## What shipped

- **saga-dash** (`e2e/stage8-partial-unskip`, rides PR #376):
  `topology-ab.e2e.test.ts` grew a trailing serial test
  `the world is browsable: ab-topology-admin@saga.org mints and sees the
  program` + header note 5. Skipped on the sandbox lane (devLogin is
  FORBIDDEN on deployed iam).
- **soa** (`docs/hermetic-flow-viewer`): `saga-stack-cli/docs/e2e-flows.md`
  (manual-verification CL in the scheduling-topology section), `docs/faq.md`
  ("How do I manually inspect a hermetic flow's world in the browser?"), and
  this plan.

**Gate:** `ss e2e run saga-dash/scheduling-topology --headless --slot 1` green
(2 passed) with the new stage, 2026-07-07.
