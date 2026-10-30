# Adam's proposal — "Canonical Dev District", a small tiered set (~3 districts)

_Captured verbatim from the 2026-07-28 session. This is the source artifact the research in
`../research/` responds to._

---

## Canonical Dev District — Synthesized recommendation (a small tiered set, ~3 districts)

Since we're OK with more than one district:

- **T1 — Canonical (primary):** one rich district (Demo-style, enriched) carrying the full
  persona/permission palette (full admin, observer/limited admin, school-scoped admin,
  lead-tutor, tutor, student, multiple-per-role, templates) + non-standard policies
  (SSO/silo/QTF/landing) + the full program/schedule matrix + sessions/pods + population edges
  + both password-login & bare-roster users + the CSV shadow-group path. (Fuses Sean's Demo
  palette with the Varied/Seed/Rep program variety.)

- **T2 — Empty Org:** admin-only, nothing else — first-run / CSV-upload-from-scratch (can't be
  represented inside a populated district).

- **T3 — Second / realistic:** realistic compact stand-in that also hosts a multi-district user
  (member of T1 + T3) so cross-district isolation / district-switcher is covered; realistic
  scale for pagination.

That's 2–3 districts + one multi-district user, covering everything the current 10 seed
districts do — the rest is duplication.

**Build vehicle:** generalize the existing `seedRepTrainingOnly` → `seed:district --slug`
primitive (deterministic uuidv5 ids, additive, idempotent, layer-ordered, PII-asserting), run
per-slug per-env — dev: all; wootdev: T1+T2; training: T1+T2+T3; prod: registry-only today,
then a distinct-slug/-domain approval-gated run. The accounts markdown doc is generated from
the catalog so it can't go stale.

## Open questions for the devs

1. **District count** — is the 3-district set (Canonical + Empty Org + Second) the right shape,
   or fold Second into Canonical (2 districts, losing clean cross-district isolation)?
2. **Fuse or separate** — put the full program/schedule matrix + sessions into the Canonical
   (demo) district, or keep a distinct "schedule / realistic" district for them?
3. **Build mechanism** — agree we generalize `seedRepTrainingOnly` → `seed:district --slug`
   (deterministic seed) rather than the ad-hoc API+CSV path used for SC-training? Same
   "playbook per env" goal, but idempotent and byte-identical.
4. **Scale target for the realistic tier** — ~200–300 students?
5. **Prod safety** — distinct district slug + email domain (never reuse `@saga.org`); confirm
   naming/domain now so the derived ids are stable from the start.
6. **PII / login** — every loginable account needs a PII row + password (the login gotcha);
   confirm which account classes are loginable vs. bare roster (also bounds the argon2
   bulk-hash issue, rostering#900).

---

## Where each question is answered

See `../research/03-pareback-feasibility.md` §5, and the epic body
([soa#381](https://github.com/saga-ed/soa/issues/381)) for the condensed positions.
