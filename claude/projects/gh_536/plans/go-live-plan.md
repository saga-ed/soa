# Vishnu go-live plan (dev → sandbox soak → prod)

Owner: Claude (deploy) with skelly approving each gate. System functionality is
iterated separately with Astra; see [`../../vishnu/docs/`](../../vishnu/docs/README.md).
Readable page (same plan, kept in sync): https://claude.ai/artifact/6onYgCn2nJ7Ut5Y5Yfss5h

Every **gate** needs skelly's explicit yes. Nothing in prod changes before a separate,
reviewed prod plan.

## Status — 2026-10-30

| Gate / step | State | Evidence |
|---|---|---|
| A. Merge soa PR#543 | ✅ 10-28 | main `cfdc82ab` |
| B. Publish packages | ✅ 10-28 | event-consumer 0.2.0, event-outbox 0.3.0, event-stats 0.1.0 (then 0.1.1, d8) |
| C. Repin adopters | ✅ | rostering PR#1783, program-hub PR#1023 (draft, CI green) |
| D. Receiver on green | ✅ 10-28 | [gate-d record](../../gh_538/docs/gate-d-mq-receiver-2026-10-28.md) |
| E. Live dev traffic to green | ✅ 10-28 | dev rule 4015 green 100 / blue 0 |
| F0. Zod 3 crash fix (d8) | ✅ 10-29 | soa PR#555, event-stats 0.1.1 |
| F1. Vishnu sandbox support (d9) | ✅ deployed for testing | draft soa PR#556 (unmerged); blue runs its image |
| F2. Adopter sandbox wiring | ✅ | `event-stats` input in both `sandbox-deploy.yml`; program-hub wiring moved to its **shared** template |
| **F4. Sandbox soak `sandbox-gh537`** | ✅ criterion met 10-29 21:43Z (3 services); **wave 1 in progress** (d10) | [soak record](../../gh_538/docs/sandbox-soak-gh537-2026-10-29.md), [manifest](../patch-party.json) |
| F3/F5/F6. Vet, brief, merge adopters | todo | saga-fleet `vet-for-merge`, `deploy-brief --pre-merge`; skelly merges |
| G. Enable reporting in dev main | todo | d7 order IAM → Programs → Scheduling, then wave-1 services |
| Prod | later, separate plan | saga-fleet `ship`; includes Vishnu itself (PR#543/#554 merged without vet blocks) |

**Success for the current phase:** hosted Vishnu (blue) shows live reports from the
deployed, reporting-enabled APIs in the sandbox. Met for iam-api, programs-api and
scheduling-api. Wave 1 (d10) adds sessions-api, content-api (deployed, waiting for
Vishnu's allowlist) and chat-api, insights-api, transcripts-api (sds adoption in progress).

## Next steps, in order

1. Wave 1: extend Vishnu `REPORTERS` on PR#556's branch (5 services; Datadog names
   confirmed), deploy the sds trio into the sandbox, rebuild blue (optionally with
   PR#558's ultrawide layout) through a reviewed change set, and verify all 8 report.
2. Soak 48h (d7), then post-soak checks: reporter failures, broker connection count,
   and shared dev IAM writes from the sandbox (preflight 4.2 finding).
3. Boot smoke check in adopter CI (owed from d8).
4. Wave 2 decision: where consumer-only services report (coach-api, authz-api,
   authz-sync), and how to test authz-api without the shared OpenFGA store.
5. Vet (`vet-for-merge`) and merge the adopter PRs (Gate F), with a prod-deploy hold
   decision for the affected services; then Gate G.
6. Explicit sandbox teardown (no TTL sweep for direct dispatches) and revert blue.

## Standing rules

- Run `/saga-fleet:doctor` before each stage (AWS SSO, gh, clones).
- `saga-bluegreen flip` is prod-only; a dev colour flip is a direct `modify-rule`.
- Broker reads use `shared-dev-mq-readonly`, held in memory only.
- Merging soa or adopter PRs is skelly's step (the auto-mode classifier blocks
  unreviewed merges by Claude).
