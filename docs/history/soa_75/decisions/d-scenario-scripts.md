# d-scenario-scripts — Scripted scenarios drive the live local stack

RESOLVED 2026-04-30: Each lifecycle dimension exercised by a `pnpm scenario:<name>` script that drives the **live local stack** (`pnpm dev:infra && pnpm dev`). Distinct from CI integration tests (testcontainers, ephemeral). Doubles as automated runbook drivers in Phase 3.5.

## Context

Late addition during the planning walkthrough. User clarified: "I forgot to confirm but I am thinking part of validation is a locally standing everything up through docker compose for testing of scenarios. Is that captured?"

Original plan captured local stack via `pnpm dev:infra` and CI integration tests via testcontainers, plus ops drills via `docker kill` against the live stack. What was NOT captured: a formal "scripted scenario" deliverable — one command per scenario that drives the live stack through a realistic flow and asserts observable outcomes.

## Distinction from CI integration tests

| Aspect | CI integration tests | Scripted scenarios |
|---|---|---|
| Stack | testcontainers (ephemeral) | live `pnpm dev:infra` (persistent) |
| Tear-down | After each test run | Manual / dev-controlled |
| Audience | CI + local `pnpm test:int` | Sanity checks, demos, runbook drivers |
| Output | pass/fail | structured progress + asserts + Jaeger URL |

## Why both

CI tests prove the system works in a hermetic environment on every PR. Scripted scenarios prove the system works **the way users will experience it** on the same Docker stack the team actually develops against. Different signals; both worth having.

## Scenarios per phase

- **Phase 1:** `scenario:user-projection` — basic event flow.
- **Phase 2:** `scenario:user-enrollment` — full triplet flow + eventual-consistency UX.
- **Phase 3:** `scenario:breaking-bump`, `scenario:poison-message`, `scenario:cold-start`, `scenario:idempotency-key`.
- **Phase 3.5:** `scenario:broker-down`, `scenario:consumer-crash`, `scenario:lag-recovery` — these double as ops drill drivers (paired with `docs/runbooks/<name>.md`).
- **Phase 4:** `scenario:trace-walkthrough` — drives a request and prints the resulting Jaeger URL.

## Shape

`scenarios/` is its own pnpm workspace package (`@example/scenarios`). Lib helpers in `scenarios/lib/` (HTTP driving, polling, structured logging). Each scenario is a TypeScript file run via `tsx`.

```typescript
// scenarios/user-projection.ts
await new Scenario('user-projection')
    .step('Wait for stack health', (ctx) => ctx.expectHealthy(['identity-svc', 'admissions-svc']))
    .step('Create user via identity-svc', async (ctx) => {
        ctx.user = await ctx.post('http://localhost:3001/users', { name: 'Ada' });
    })
    .step('Wait for projection in admissions-svc', async (ctx) => {
        await ctx.pollUntil(() => ctx.get(`http://localhost:3003/users/${ctx.user.id}`),
                            (res) => res.status === 200,
                            { timeoutMs: 5000 });
    })
    .step('Print trace URL', (ctx) => {
        ctx.log(`Trace: http://localhost:16686/search?service=identity-svc&tags={"correlationId":"${ctx.correlationId}"}`);
    })
    .run();
```

## Updated final gate

"On-call rookie can run `pnpm scenario:<name>` cold against `pnpm dev:infra`, watch the stack behave, AND read `docs/runbooks/<name>.md` to understand what they just saw, and recover from a simulated incident in under 15 minutes."

## Related artifacts

- POC plan: `/home/spaul/.claude/plans/fancy-finding-dream.md` (verification plan + per-phase scenario callouts)
- Scenario stub: `/home/spaul/dev/soa_event_driven_example/.claude/worktrees/fancy-finding-dream/scenarios/README.md`
