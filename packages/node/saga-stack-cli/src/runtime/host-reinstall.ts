/**
 * `host-reinstall` — restore the HOST repo's `node_modules` INLINE during a
 * `cold-start --reinstall`, before anything relies on it again (soa#cold-start).
 *
 * THE BUG THIS CLOSES: cold-start's clean-build phase does `rm -rf node_modules`
 * in every repo under `--reinstall`, then DEFERS the reinstall to the later
 * `up`/prep pass. That is fine for the sibling repos — but the repo that hosts
 * the running `ss` binary (soa) keeps `@oclif/core` and the rest of the CLI's
 * OWN runtime under `soa/node_modules/.pnpm`. Deleting it mid-run means: if the
 * subsequent `up`/prep fails BEFORE it reinstalls soa (e.g. a wedged prep lock),
 * the store stays empty and EVERY later `ss` invocation dies at load with
 * `ERR_MODULE_NOT_FOUND: @oclif/core` — the tool has bricked its own runtime and
 * cannot run the step that would fix it. The manual escape was a bare
 * `pnpm install`; this automates it.
 *
 * So cold-start calls `reinstallHostRepo(soaRoot, …)` the instant the clean phase
 * removes the host repo's `node_modules`, restoring `ss` regardless of whether
 * the later `up` succeeds. The install mirrors prep's own `pnpm install`
 * (`src/runtime/prep.ts`): a CodeArtifact 401 (expired token) triggers a single
 * `pnpm co:login` refresh + retry.
 *
 * IO-only: the real spawning lives behind the injected `Runner` seam (`exec.ts`),
 * so this is unit-tested with a fake runner (no real `pnpm`).
 */

import type { Runner } from './exec.js';

/** Injected deps for a host-repo reinstall. */
export interface HostReinstallDeps {
  /** The process seam — `pnpm install` / `pnpm co:login` run through it. */
  runner: Runner;
  /** Progress sink (defaults to a no-op). */
  notify?: (message: string) => void;
}

/** The outcome of a host-repo reinstall. */
export interface HostReinstallResult {
  /** True iff the final `pnpm install` exited 0. */
  ok: boolean;
  /** True iff a CodeArtifact 401 forced a `pnpm co:login` + retry. */
  reloggedIn: boolean;
}

/**
 * Run `pnpm install` in `root` (the host repo), with a single CodeArtifact-401
 * `pnpm co:login` refresh + retry — exactly prep's install recovery. Pure w.r.t.
 * IO: every spawn goes through `deps.runner`.
 */
export async function reinstallHostRepo(
  root: string,
  deps: HostReinstallDeps,
): Promise<HostReinstallResult> {
  const notify = deps.notify ?? ((): void => {});
  const install = (): Promise<import('./exec.js').RunResult> =>
    deps.runner.run({
      cwd: root,
      command: 'pnpm',
      args: ['install'],
      env: {},
      stdio: 'inherit',
      detectUnauthorized: true,
    });

  let result = await install();
  let reloggedIn = false;

  // FLIP 4 parity: an expired CodeArtifact token surfaces as a 401 — refresh via
  // `pnpm co:login`, then retry the install ONCE (mirrors prep's `prepOneRepo`).
  if (result.code !== 0 && result.unauthorized) {
    notify('    CodeArtifact token expired — refreshing (pnpm co:login) and retrying install once');
    reloggedIn = true;
    await deps.runner.run({ cwd: root, command: 'pnpm', args: ['co:login'], env: {}, stdio: 'inherit' });
    result = await install();
  }

  return { ok: result.code === 0, reloggedIn };
}
