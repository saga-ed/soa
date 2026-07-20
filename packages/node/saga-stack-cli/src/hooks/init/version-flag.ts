/**
 * init hook: route `ss -v` / `ss --version` to the `version` command (soa#341).
 *
 * oclif's built-in `--version` prints the STATIC package.json version; ours is
 * runtime-derived (auto patch + sha + dirty), so both spellings must reach the
 * same command or the two outputs would disagree. The hook fires before
 * command dispatch: on a version spelling it runs `version` and exits 0, so
 * the built-in handler (and the "command not found" error for `-v`) is never
 * reached. Everything else falls through untouched.
 */

import type { Hook } from '@oclif/core';

const hook: Hook<'init'> = async function (opts) {
  if (opts.id === '-v' || opts.id === '--version') {
    await opts.config.runCommand('version', []);
    // NOT this.exit(): runHook() CAPTURES hook exceptions (including ExitError),
    // so dispatch would continue and die on "command -v not found". A hard exit
    // is safe here: the version command's output is synchronous tty writes.
    process.exit(0);
  }
};

export default hook;
