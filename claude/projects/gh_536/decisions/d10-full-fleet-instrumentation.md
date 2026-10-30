# d10 — Instrument the full set of event-driven APIs for the sandbox soak

RESOLVED — 2026-10-30

User ruling: "As recommended". Option 2, two waves. Wave 1 now: sessions-api and
content-api (program-hub), chat-api, insights-api and transcripts-api (sds), added to
the `sandbox-gh537` soak. Wave 2 (coach-api, authz-api, authz-sync) waits on a ruling
on where consumer-only services report, and keeps authz-api's tuple writes out of the
shared OpenFGA store.

## Context

skelly asked to instrument "the full complement of APIs" with event telemetry and add
them to the `sandbox-gh537` soak. Today three services report (iam-api, programs-api,
scheduling-api). An `origin/main` sweep finds ten more services that use the soa
outbox or consumer packages:

| Repo | Services to add | Role | Sandbox (`sandbox-deploy.yml`) | Zod |
|---|---|---|---|---|
| program-hub | sessions-api, content-api | consume and produce | yes (any of the four) | forced 3 (fine with event-stats 0.1.1) |
| student-data-system | chat-api, insights-api, transcripts-api | produce only | yes (allowlisted; `dbProfile` must be `""`) | 4 |
| coach | coach-api | consume only | yes | forced 3 |
| rostering | authz-api | consume only | yes, but shares the dev OpenFGA store | 4 |
| rostering | authz-sync | consume only | **no** (not on the allowlist) | 4 |

Not covered: ads-adm-api uses only the event envelope package, not the outbox or
consumer, so the telemetry hooks don't apply without custom wiring.

Each new service needs:

- an adoption change (pin event-stats 0.1.1 plus the matching consumer/outbox versions,
  wire `createServiceEventStats`, regenerate the lock file);
- the `EventStatsEnabled` template parameter **in the template its dev/prod config
  actually deploys** (program-hub uses the shared template; check each repo's
  samconfig);
- a default-off `event-stats` input in its `sandbox-deploy.yml`;
- a Vishnu `REPORTERS` entry (d6 A1 fails closed on unknown services).

Every repo's lock file change also carries the same outbox and consumer version jump
as the first three.

### The open design question: where consumer-only services report

d1 has each service publish reports on **its own** exchange. authz-api, authz-sync and
coach-api don't publish anything, so they have no exchange of their own. Options:

- **i.** Report on the exchange they mainly consume (authz-api and authz-sync on
  `iam.events`, coach-api on `iam.events`). No new topology, but a service publishes on
  another team's exchange, which breaks the publisher-owned convention in d1.
- **ii.** A dedicated `observability.events` exchange that all reporters use (d1's
  original option 2). Clean ownership, but it is new shared topology with an owner to
  name, and every reporter's routing changes.
- **iii.** Leave consumer-only services out of this round.

## Options (scope)

1. **Everything now.** All ten services in this soak, consumer-only reporting per
   (i) or (ii), plus a rostering PR to add authz-sync to the sandbox allowlist.
   - Most coverage. Five adopter changes across four repos, a design change, and the
     authz-api sandbox writing tuples into the **shared dev OpenFGA store** (patch-party
     §4.2). That changes dev's authorization data for everyone.
2. **Two waves.** Wave 1 adds the services that need no new design and no shared-state
   risk: sessions-api and content-api (same program-hub branch and PR) and chat-api,
   insights-api and transcripts-api (an sds adoption PR, producers on their own
   exchanges). Wave 2, after a ruling on the consumer-only question: coach-api, and
   authz-api and authz-sync **through `ss` or dev main rather than the sandbox**,
   because of OpenFGA.
   - 8 of 13 services reporting in the soak quickly, with no shared-state writes; the
     rest follow a deliberate design choice.
3. **Keep the soak at three.** Discuss the fleet rollout with Seth first (overlap with
   native broker and APM metrics, connection churn), then plan the rest.
   - No new work now, but it doesn't meet the ask.

## Recommendation

**Option 2.** Wave 1 needs only the established pattern:
- sessions-api and content-api ride the existing program-hub branch and PR;
- the sds trio are producers, which d1 already covers.

Wave 2 waits on two things: the consumer-only exchange question (a ruling, with
(ii) worth raising with Seth), and keeping authz-api's tuple writes out of the shared
OpenFGA store. Confidence: high on the split, medium on the wave 2 approach until
the consumer-only question is settled.

Load at full rollout (13 services, prod host counts): about 1 report per second and
one short-lived broker connection per report. That is still small next to about 70
messages per second (see the F/G risk page).

## Related artifacts

- `/home/skelly/dev/worktrees/soa-gh_536-event-telemetry/claude/projects/gh_537/research/participant-inventory.md`
- `/home/skelly/.claude/plugins/cache/saga-tools/saga-iac/1.22.0/skills/patch-party/SKILL.md` (§4.2 OpenFGA, §4.4 sds `dbProfile`, §4.9 allowlists)
- [d1](d1-event-stats-routing.md), [d6](d6-topology-mapping.md), [d9](d9-vishnu-sandbox-observation.md) (on PR#556 branch)
- Risk page: https://claude.ai/artifact/FC8k6W1ZiZHW9o1V8Bp4is
