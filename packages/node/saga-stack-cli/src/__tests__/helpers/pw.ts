/**
 * Playwright child-argv builder (M15-C test-harness consolidation, T5).
 *
 * Mirrors the argv assembly in e2e-orchestrate.ts (`exec playwright test
 * --config=… --project <p> [--no-deps] [--grep-invert <tag>] [--headed]`) for
 * VARIANT exact-array assertions — the ones that differ from the golden pin
 * only in project/flags. The config is pinned to the bundled example's
 * `playwright.stack.config.ts`, which is what every hermetic suite resolves.
 *
 * INTENTIONALLY NOT USED for the golden anchors: run.int.test.ts's happy-path
 * exact-array pin and the two --dry-run prose strings (run.int + e2e.int) stay
 * fully literal so a regression in the argv/prose SHAPE itself can never be
 * masked by this builder drifting in the same direction.
 */

export interface PwArgvOptions {
  /** Playwright `--project` (the terminal stage). */
  project: string;
  /** Append `--headed` (foreground flows). */
  headed?: boolean;
  /** Append `--no-deps` (checkpoint window runs break the stage chain). */
  noDeps?: boolean;
  /** Append `--grep-invert <tag>` (pipeline runs exclude e.g. `@interactive`). */
  grepInvert?: string;
  /** Append the terminal stage's `spec` (scopes the run to just that spec file). */
  spec?: string;
}

/** Build the expected `pnpm` args array for a spawned Playwright child. */
export function pwArgv(opts: PwArgvOptions): string[] {
  const argv = ['exec', 'playwright', 'test', '--config=playwright.stack.config.ts', '--project', opts.project];
  if (opts.noDeps) argv.push('--no-deps');
  if (opts.grepInvert !== undefined) argv.push('--grep-invert', opts.grepInvert);
  if (opts.headed) argv.push('--headed');
  if (opts.spec !== undefined) argv.push(opts.spec);
  return argv;
}
