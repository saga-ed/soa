# 03 — Deployment state (snapshot 2026-10-30)

This is a dated snapshot. GitHub and AWS are authoritative. Re-check before acting.

## Vishnu (dev)

| Colour | Image | Role | MQ scope |
|---|---|---|---|
| **green** (live, rule 4015 = 100) | `soa/vishnu-api:15098712` (main code as of Gate D) | Live dev viewer | `dev / main / shared-dev-mq / /`. No dev-main reporters are enabled yet, so no MQ icons. |
| **blue** (header only) | `soa/vishnu-api:3db18670` (draft PR#556) | Sandbox observer | `dev / sandbox-gh537 / shared-dev-mq / /` |

Prod: none.

## Sandbox `sandbox-gh537` (patch-party, direct dispatch, TTL 72h, explicit teardown)

| Service | Repo | Revision | Reporting | Seen by blue |
|---|---|---|---|---|
| iam-api | rostering | `3b552682` | on | yes |
| programs-api | program-hub | `40adb410` | on | yes |
| scheduling-api | program-hub | `40adb410` | on | yes |
| sessions-api | program-hub | `9bd2e9f3` | on | after the allowlist update (wave 1) |
| content-api | program-hub | `9bd2e9f3` | on | after the allowlist update (wave 1) |
| chat-api, insights-api, transcripts-api | student-data-system | — | sds adoption in progress | wave 1 |

## Packages (CodeArtifact)

event-stats **0.1.1** (Zod 3/4), event-consumer 0.2.0, event-outbox 0.3.0.

## Branches and PRs

| PR | Branch | State | Contents |
|---|---|---|---|
| soa PR#543, #554, #555 | — | merged | Telemetry, receiver, d3–d7 code, Zod fix |
| soa **PR#556** | `gh_538-vishnu-sandbox` | draft | Sandbox observation (d9). Blue runs it. |
| soa **PR#558** | `gh_538-vishnu-ultrawide-layout` | draft | Ultrawide layout (canvas-shaped layering) |
| rostering **PR#1783** | `gh_537-event-stats-adoption` | draft | iam-api adoption, template, sandbox input |
| program-hub **PR#1023** | `gh_537-event-stats-adoption` | draft | programs, scheduling, sessions and content adoption; shared template; sandbox input |
| sds (new) | `gh_537-event-stats-adoption` | in progress | chat, insights, transcripts adoption |

Local synthetic: slot 3 (`ss` set `gh536`) Vishnu at http://127.0.0.1:11930 with iam, programs
and scheduling reporting.
