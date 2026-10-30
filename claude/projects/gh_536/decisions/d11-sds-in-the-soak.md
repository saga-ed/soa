# d11 — How the sds services join the soak (wave 1)

RESOLVED — 2026-10-30

User ruling: "Option 2". Fix sds sandbox isolation first: tag sds sandbox exchanges
(`EventPreviewTag` from the sandbox identifier) and transcripts-api's consumer
topology, then sandbox chat-api, insights-api and transcripts-api in `sandbox-gh537`.
The fix rides sds PR#869 (fewer PRs). Vishnu then adds the three to `REPORTERS` and
`declaredEventBus`.

## Context

d10 wave 1 includes the student-data-system (sds) producers chat-api, insights-api and
transcripts-api. Their adoption is done in draft sds PR#869 (48/48 tasks, 468 tests;
booted against a throwaway broker, all three publish reports with reporting on).
Exchanges: `chat.events`, `insights.events`, `transcripts.events`.

The adoption session found that **sds sandboxes don't isolate their broker topology**:

1. sds sandbox stacks run with an empty `EventPreviewTag`, so a sandboxed service
   publishes business events on the **same exchanges as dev main**. Any dev consumer of
   `chat.events`, `insights.events` or `transcripts.events` would receive sandbox events.
2. transcripts-api consumes `transcripts-api.transcript-ready` on `transcription.events`
   with its own AMQP connection, and that queue is **not tagged**. A sandboxed copy
   attaches a second consumer to the **shared dev queue**, and RabbitMQ round-robins, so
   about half of dev's transcript-ready messages would be silently taken (patch-party §4.2).

Both predate the telemetry work. Deploying sds into `sandbox-gh537` would trigger them.
Also, blue's sandbox observation (d9) binds tagged exchanges, so it would not see untagged
sds reports without a special case.

## Options

1. **Keep sds out of the sandbox; prove it elsewhere.** Run chat, insights and
   transcripts with reporting on in the local `ss` stack (slot 3 viewer), and enable them
   in dev main at Gate G after PR#869 merges. Green then observes them on the untagged
   exchanges as deployment `main`.
   - Safe now, no sds infrastructure work, and the soak still covers 5 services. The
     sandbox-level evidence for sds is local, not hosted.
2. **Fix sds sandbox isolation first.** Tag sds sandbox topology (set `EventPreviewTag`
   in sds `sandbox-deploy.yml` and tag transcripts' consumer queue), then sandbox all three.
   - Gives full hosted sandbox evidence and fixes a real shared-dev hazard for everyone who
     sandboxes sds. It is an sds change outside telemetry (its own PR, review and risk),
     and it delays the soak.
3. **Sandbox only chat-api and insights-api, untagged,** and add an untagged-exchange
   special case to blue.
   - Quick, but sandboxed producers would publish on dev main's exchanges, and Vishnu gains
     a special case that weakens d9. Not recommended.

## Recommendation

**Option 1 now, and raise option 2 as a separate sds fix.** The soak continues with 5
services (iam, programs, scheduling, sessions, content). sds reporting is proven locally
and then in dev main at Gate G. The shared-dev hazard in sds sandboxes (especially
transcripts' queue) should go to the sds owners as its own issue, independent of telemetry.
Confidence: high.

## Related artifacts

- sds PR#869: https://github.com/saga-ed/student-data-system/pull/869 (worktree
  `/home/skelly/dev/student-data-system/.claude/worktrees/gh_537-event-stats-adoption`)
- `/home/skelly/.claude/plugins/cache/saga-tools/saga-iac/1.22.0/skills/patch-party/SKILL.md` (§4.2)
- [d9](d9-vishnu-sandbox-observation.md), [d10](d10-full-fleet-instrumentation.md)
