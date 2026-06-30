/**
 * Absolute-path resolution for the unchanged bash scripts the M1 wrappers
 * shell out to: `up.sh` and `verify.sh`, both living in the synthetic-dev tool
 * dir under the soa repo.
 *
 * Resolution precedence (matches up.sh's own header, ~line 167):
 *   SOA root = `--soa` override → `$SOA` → `<dev>/soa`
 *   dev      = `--dev` override → `$DEV` → `$HOME/dev`
 *   scriptCwd = `<soaRoot>/tools/synthetic-dev`
 *
 * This module is runtime (not core): it does pure path building plus ONE
 * `existsSync` guard in `resolveScript` so a missing/mis-pathed checkout fails
 * with a clear message instead of an opaque spawn ENOENT. No spawning here.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Known bash scripts the wrappers may shell out to. */
export type ScriptName = 'up.sh' | 'verify.sh';

/**
 * The inputs needed to locate the scripts. Both fields are the user's explicit
 * overrides (CLI `--soa` / `--dev`), or `undefined` to fall back to env/HOME.
 * Sourced from the shared global flags.
 */
export interface ScriptContext {
  /** `--soa` override: pins the soa repo checkout directly. */
  soa?: string;
  /** `--dev` override: the sibling-repo workspace root. */
  dev?: string;
}

/** The sibling-repo workspace root: `--dev` → `$DEV` → `$HOME/dev`. */
export function resolveDevRoot(ctx: ScriptContext = {}): string {
  return ctx.dev ?? process.env.DEV ?? join(process.env.HOME ?? '', 'dev');
}

/** The soa repo root: `--soa` → `$SOA` → `<dev>/soa`. */
export function resolveSoaRoot(ctx: ScriptContext = {}): string {
  return ctx.soa ?? process.env.SOA ?? join(resolveDevRoot(ctx), 'soa');
}

/** The synthetic-dev tool dir — the cwd the bash scripts expect to run from. */
export function scriptCwd(ctx: ScriptContext = {}): string {
  return join(resolveSoaRoot(ctx), 'tools', 'synthetic-dev');
}

/**
 * Absolute path to `up.sh`/`verify.sh`. Throws (with the resolved soa root and
 * the precedence hint) if the file is absent, so the user gets a pointed error
 * before any spawn is attempted.
 */
export function resolveScript(name: ScriptName, ctx: ScriptContext = {}): string {
  const dir = scriptCwd(ctx);
  const path = join(dir, name);
  if (!existsSync(path)) {
    throw new Error(
      `saga-stack: could not find ${name} at ${path}\n` +
        `  resolved soa root: ${resolveSoaRoot(ctx)}\n` +
        `  set --soa <path-to-soa>, $SOA, or --dev/$DEV so <dev>/soa is correct.`,
    );
  }
  return path;
}
