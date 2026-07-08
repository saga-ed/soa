/**
 * `host-reinstall` — restore the HOST repo's own runtime (`node_modules` AND
 * `dist`) INLINE during a `cold-start`, before anything relies on it (soa#cold-start).
 *
 * THE BUG THIS CLOSES: cold-start's clean-build phase `rm -rf`s each repo's `dist`
 * (always) and `node_modules` (under `--reinstall`), then DEFERS the rebuild/reinstall
 * to the later `up`/prep pass. That is fine for the sibling SERVICE repos — but soa,
 * which hosts the running `ss` binary, is NOT a service in the up-closure, so phase 6
 * never touches it. And soa is exactly where the CLI's own runtime lives:
 *   - `@oclif/core` + the rest of the dep tree under `soa/node_modules/.pnpm`, and
 *   - the compiled command files under `soa/packages/node/saga-stack-cli/dist/commands/**`.
 * Wiping either and not restoring it bricks EVERY later `ss` invocation —
 * `ERR_MODULE_NOT_FOUND: @oclif/core` (missing node_modules) or
 * `MODULE_NOT_FOUND: …/dist/commands/stack/<cmd>.js` (missing dist) — even after a
 * fully GREEN cold-start. The manual escape was `pnpm install` + a rebuild; this
 * automates both.
 *
 * So cold-start calls, the instant the clean phase removes soa's runtime:
 *   - `reinstallHostRepo(soaRoot, …)` under `--reinstall` — `pnpm install`, mirroring
 *     prep's own recovery (a CodeArtifact 401 triggers a `pnpm co:login` refresh + retry).
 *   - `rebuildHostCli(soaRoot, …)` always — `turbo run build` for the CLI package, since
 *     the clean removes soa's `dist` even without `--reinstall`.
 *
 * IO-only: the real spawning lives behind the injected `Runner` seam (`exec.ts`),
 * so both are unit-tested with a fake runner (no real `pnpm`/`turbo`).
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

/** The workspace name of the ss CLI package — the `dist/` the running binary loads. */
export const HOST_CLI_PACKAGE = '@saga-ed/saga-stack-cli';

/** The outcome of a host-CLI rebuild. */
export interface RebuildHostCliResult {
  /** True iff the `turbo run build` exited 0. */
  ok: boolean;
}

/**
 * Rebuild the host CLI package's `dist/` — a `turbo run build --filter=<HOST_CLI_PACKAGE>`
 * in the host repo root.
 *
 * THE SECOND HALF of the cold-start self-brick (the first is `reinstallHostRepo`): the clean
 * phase `rm -rf`s every `<pkg>/dist` under soa — INCLUDING the saga-stack-cli
 * `dist/commands/**` the running `ss` binary discovers its commands from — and it does so
 * EVEN WITHOUT `--reinstall`. Phase 6's up/prep only builds the SERVICE repos in the
 * up-closure, never soa itself, so nothing restores that `dist/`. Without an inline rebuild the
 * next `ss` command dies with `MODULE_NOT_FOUND: …/dist/commands/stack/<cmd>.js` — even after a
 * fully green cold-start. turbo restores the CLI (and any build-time deps) from the graph.
 *
 * IO-only: the spawn goes through the injected `Runner` seam, so this is unit-tested with a
 * fake runner (no real turbo/tsc).
 */
export async function rebuildHostCli(root: string, deps: HostReinstallDeps): Promise<RebuildHostCliResult> {
  const result = await deps.runner.run({
    cwd: root,
    command: 'pnpm',
    args: ['turbo', 'run', 'build', `--filter=${HOST_CLI_PACKAGE}`],
    env: {},
    stdio: 'inherit',
  });
  return { ok: result.code === 0 };
}
