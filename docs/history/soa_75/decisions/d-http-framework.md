# d-http-framework — Inversify + plain `@trpc/server`, mirroring iam-api

RESOLVED 2026-04-30: Express + Inversify (services only) + plain `@trpc/server` (HTTP layer), matching iam-api conventions. Explicitly NOT the `AbstractTRPCController` / `ControllerLoader` pattern from `HowToAddPubsub.md`.

## Context

The POC needs a service framework. Two competing patterns exist in the soa fleet:

- **iam-api pattern** (rostering): plain `@trpc/server` with `initTRPC.context<...>().create()`, hand-composed `appRouter`, sectors export plain tRPC routers. Inversify is used **only** for service-layer composition (data services like `UserDataService`).
- **`@saga-ed/soa-api-core` pattern** (described in `HowToAddPubsub.md:609-697`): controllers extend `AbstractTRPCController`; `ControllerLoader` discovers them via filesystem glob; `ExpressServer` mounts them via the container. More framework-ish.

The user's stated goal: "alignment with the current systems" (iam-api / programs-api / ads-adm-api) plus "container `rebind()` for test mocking is a team-known pattern."

## Options considered

1. **iam-api-style: Inversify for services + plain tRPC for HTTP** *(chosen)*
   - Each service has `src/inversify.config.ts`, `src/main.ts`, `src/app-router.ts`, `src/trpc.ts`, `src/sectors/<domain>/{<domain>.data.ts, <domain>.router.ts, ...}/`.
   - Routers are plain tRPC routers (no `@injectable`).
   - Services bound to Inversify container; resolved in main.ts; passed into context factory.
   - Tests use `buildContainer()` factory + `container.rebind()` for mocks.
2. **AbstractTRPCController + ControllerLoader** (HowToAddPubsub.md style) — controllers `@injectable`-decorated; loaded by glob at startup. Heavier; extra moving parts that none of the three reference services use.
3. **Plain Express + factory composition root, no Inversify** — simplest in isolation. Diverges from fleet; loses the `rebind()` test-mock ergonomics.
4. **NestJS** — framework lock-in; not what real services use.

## Recommendation

**Option 1.** Reasons:

1. **Fleet alignment** — the three services this POC models (iam-api, programs-api, ads-adm-api) all use this pattern. Lessons port directly.
2. **`container.rebind()` for tests** — the team has built muscle memory around this; preserving it preserves test ergonomics.
3. **Skip the controller-loader complexity** — `loadControllers()` adds a glob-based discovery layer that doesn't compose well with bundlers and is harder to grep. iam-api works fine without it.

## Discovery worth surfacing

The plan originally said we'd use `AbstractTRPCController` + `ControllerLoader` (HowToAddPubsub.md pattern). Reading iam-api's source revealed it does NOT use that pattern. The plan was updated mid-execution; the POC's identity-svc baseline matches iam-api directly.

## Related artifacts

- POC plan: `/home/spaul/.claude/plans/fancy-finding-dream.md` § D3
- iam-api references:
  - `/home/spaul/dev/rostering/apps/node/iam-api/src/main.ts`
  - `/home/spaul/dev/rostering/apps/node/iam-api/src/inversify.config.ts`
  - `/home/spaul/dev/rostering/apps/node/iam-api/src/trpc.ts`
  - `/home/spaul/dev/rostering/apps/node/iam-api/src/app-router.ts`
  - `/home/spaul/dev/rostering/apps/node/iam-api/src/sectors/user/user.router.ts`
- POC baseline: `/home/spaul/dev/soa_event_driven_example/.claude/worktrees/fancy-finding-dream/apps/identity-svc/`
