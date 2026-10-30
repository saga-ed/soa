# Vishnu — system docs (for Astra and anyone picking up the work)

Vishnu is Saga's staff-only viewer of how services connect and how healthy their
messaging is. It combines Datadog APM with live event-count reports that services
publish over RabbitMQ.

**How the work is split:** skelly iterates on **system functionality** with Astra.
Claude runs the **go-live plan** (deploys, gates, soak). Every gate needs skelly's
explicit approval.

| Doc | What it answers |
|---|---|
| [01 System overview](01-system-overview.md) | What Vishnu is made of, where the code lives, how it's hosted |
| [02 Telemetry pipeline](02-telemetry-pipeline.md) | How a service's event counts reach the Vishnu UI |
| [03 Deployment state](03-deployment-state.md) | What runs where right now (dated snapshot) |
| [04 Decisions](04-decisions.md) | Index of d1–d10, one line each, with links |
| [05 Open work](05-open-work.md) | Functionality backlog (Astra) vs go-live steps (Claude) |
| [06 Operations](06-operations.md) | Runbooks, how to view blue, sandbox, audits |
| [07 Delta updates](07-delta-updates.md) | Append-only log of go-live-side changes for Astra (newest first) |

## Sources of truth (read these, not copies)

- **Decisions:** [`../../gh_536/decisions/`](../../gh_536/decisions/) (d1–d10, all resolved)
- **Go-live plan:** [`../../gh_536/plans/go-live-plan.md`](../../gh_536/plans/go-live-plan.md)
  (page: https://claude.ai/artifact/6onYgCn2nJ7Ut5Y5Yfss5h)
- **Evidence records:** [`../../gh_538/docs/`](../../gh_538/docs/)
- **Risk page for the fleet discussion with Seth:** https://claude.ai/artifact/FC8k6W1ZiZHW9o1V8Bp4is
- **Issues:** soa I#536 (epic), I#535 (shared stats), I#537 (adoption), I#538 (Vishnu receiver/UI).
  GitHub holds status; these docs hold the why.

Older working notes for the first build (implementation plan, prompts, research) are in
this project's `plans/`, `prompts/` and `research/` folders. Treat them as history.
