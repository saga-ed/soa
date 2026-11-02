# Why arm64, and how emulation came about

Measured 2026-10-30.

## ARM is a cost decision

- Prod runs Graviton (c7g, c6g, m7g): iac `cloudformation_templates/ecs/cluster/samconfig.yaml:94-118`.
- Dev moved in June 2026 (hipponot/iac PR#419) "for cost reduction, mirroring what prod already does": iac `docs/dev-shared-cluster-arm-migration-plan.md:3-4`. Lines 64-65 put the saving at about 20%, plus Graviton price/performance.
- No performance rationale is documented. Why prod first chose Graviton isn't recorded.

## Nobody chose emulation

- `OPS.md` step 3 is a manual `docker build --platform linux/arm64`. On an x86 machine with only the default builder, that means QEMU.
- ci-actions' default path also uses QEMU (ACT:381-400).
- `native-multiarch-build: 'true'` opts into `ubuntu-24.04-arm`, non-prod only (ci-actions PR#12; measured the emulated leg at about 15 of a 19-minute build).
- Prod builds take the emulated path, unless a caller opts into `promote-from-dev`, which copies the dev image without a rebuild.
- ci-actions PR#101 dropped the amd64 leg in v2.24. saga-iac docs lag: saga-ed/claude-plugins#241.

## Synthetic dev involves no image

`ss` launches Vishnu with `pnpm dev --strictPort` on port 8930 from `apps/web/vishnu` (`packages/node/saga-stack-cli/src/core/manifest/services.ts:601-616`).
