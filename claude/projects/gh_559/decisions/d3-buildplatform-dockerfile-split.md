# d3 — Keep the `$BUILDPLATFORM` Dockerfile split?

**RESOLVED 2026-11-02: Option A** (skelly). Drop the split. The Dockerfile keeps one platform throughout, and a manual x86 build remains possible but slow.

## Context

This split (`FROM --platform=$BUILDPLATFORM` on the build stage) was first proposed so local x86 builds wouldn't run Vite and tsup under QEMU. Since then, each case it was meant to help has gone away:

- **Synthetic dev** builds no image (native Node, skelly 2026-10-30).
- **Dev, sandbox and PR-preview** builds move to a native ARM runner, where `$BUILDPLATFORM` is already arm64, so the split changes nothing.
- **Prod** doesn't exist for Vishnu. If it comes, `promote-from-dev` copies the dev image into prod without a rebuild (WF@v2.51, `promote-image` job), though that path isn't confirmed for Vishnu.

What's left is a manual build on an x86 machine, as a fallback if CI is down.

The risk: the build stage also runs `pnpm deploy --prod`, and that output goes into the arm64 image. On an x86 build stage, any native module would ship x86 binaries. The API's direct dependencies look pure JS (`express`, `pg`, `amqplib`, `inversify`), but the workspace packages' transitive dependencies aren't audited. A mistake here would surface at runtime in a deployed task, not at build time.

## Options

**A. Drop it.** The Dockerfile keeps one platform throughout. A manual x86 build still works, just slowly.
- Cost: nothing.
- Limit: a break-glass local build stays slow, about 3+ minutes of heavy CPU as seen on 2026-10-30.

**B. Keep it, build stage only.** Requires a native-module audit and a smoke test of an x86-built image on ARM.
- Cost: the audit, plus a Dockerfile that's harder to reason about.
- Limit: it benefits only the break-glass case, and it needs re-auditing as dependencies change.

**C. Keep it, with production dependencies installed in a separate arm64 stage.** Removes the native-module risk.
- Cost: one more stage, and that stage still runs `pnpm install` under QEMU on x86, so it gives back some of the saving.
- Limit: the most complex option, for the same rare case.

## Recommendation

**A.** The problem that prompted the split is solved by moving builds to CI. Note that this drops something you originally asked for, though your native-Node ruling removed the reason for it.

## Related artifacts

- I#560
- `plans/01-plan-of-record.md`
- `research/02-why-arm64-and-emulation.md`
