# d8 — event-stats 0.1.0 crashes Zod 3 services at startup

RESOLVED — 2026-10-29

User ruling: "1 please". Ship event-stats 0.1.1 compatible with Zod 3 and 4, with a CI
job that runs its tests under Zod 3, then repin both adopters and add a service-boot
smoke check to adopter CI. Gate F stays held until all three services boot in slot 3
on 0.1.1.

## Context

Bringing the slot-3 synthetic stack back up with the adopter branches on **published**
packages, programs-api and scheduling-api fail at module load:

```
@saga-ed/soa-event-stats@0.1.0 …  reportId: z.uuid(),
TypeError: z.uuid is not a function
```

- `packages/node/event-stats/src/contract.ts` uses `z.uuid()`, which exists only in
  Zod 4. The package declares `zod ^4.4.3`.
- program-hub's root `package.json` has `pnpm.overrides: { "zod": "^3.24.0" }`, present
  since the repo's initial commit. It forces every package, event-stats included, onto
  Zod 3.25.76.
- The crash happens on **import**, so it occurs **with reporting off**. Merging
  program-hub PR#1023 as it stands would break programs-api and scheduling-api startup
  in dev, and in prod on their next deploy.
- rostering has no Zod override, so iam-api is unaffected (it is reporting now).

Why nothing caught it:

- The earlier synthetic runs used linked workspaces (SOA's Zod 4).
- Adopter CI and the Gate C checks build and run tests, but no test boots the service
  entrypoint.
- Gate D exercised only Vishnu's receiver.

## Options

1. **Fix the package: event-stats 0.1.1, compatible with Zod 3 and 4.** Use
   constructs both versions support (e.g. `z.string().uuid()`), audit the rest of the
   contract for Zod-4-only calls, and add a CI job that runs event-stats' tests under
   Zod 3. Then publish 0.1.1 and repin both adopters.
   - Fixes it for every Zod 3 or overridden repo in a fleet rollout, not just
     program-hub. Costs a small release and a re-run of Gate C for both adopters.
2. **Scoped override in program-hub:** `"@saga-ed/soa-event-stats>zod": "^4.4.3"`.
   - Lock file change only, no new release. But it hides the problem: the next Zod 3
     adopter hits the same crash, and the override is easy to lose in a later edit.
3. **Move program-hub to Zod 4.**
   - The right long-term direction, but a large, unrelated migration. Not something to
     do for a telemetry rollout.

## Recommendation

**Option 1**, plus a boot smoke test in the adopters' CI: start the service
entrypoint with reporting off and expect a healthy `/health`. That would have caught
this. Hold Gate F until 0.1.1 is published and both adopters are repinned and booted
in slot 3. Confidence: high.

Seth's `saga-fleet:deploy-brief` (step 4) treats two resolved versions of an
identity-sensitive family, Zod included, in one service's closure as an automatic HOLD.
Option 2 would create exactly that in programs-api and scheduling-api, so only option 1
passes the fleet's own pre-deploy check.

## Related artifacts

- `/tmp/sds-synthetic-s3/programs-api.log` and `/tmp/sds-synthetic-s3/scheduling-api.log` (crash traces)
- `/home/skelly/dev/worktrees/soa-gh_536-event-telemetry/packages/node/event-stats/src/contract.ts` (lines 1, 50, 52)
- `/home/skelly/dev/worktrees/program-hub-gh_537-event-stats-adoption/package.json` (`pnpm.overrides.zod`)
- [d7](d7-activation-and-rollback.md); Gate F risk page https://claude.ai/artifact/FC8k6W1ZiZHW9o1V8Bp4is
