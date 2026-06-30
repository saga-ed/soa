/**
 * The process-spawning seam (plan §7.2 "M1 — Wrapped daily-driver").
 *
 * Every M1 wrapper command (`stack up/down/restart/status/verify/seed/reset/
 * login`) maps its flags to an exact argv + env and then asks a `Runner` to
 * `exec` the UNCHANGED bash script. That indirection is the whole point: the
 * command layer stays pure data-shaping, and the ONLY place a real OS process
 * is ever launched is `makeRealRunner()` below.
 *
 * Tests REPLACE the Runner with a fake that records the `ScriptInvocation` and
 * returns a canned exit code — so the M1 golden tests can assert the exact
 * argv/env handed to up.sh/verify.sh (the top-named risk in the plan) WITHOUT
 * launching docker/pnpm/anything. Keep this file tiny and IO-free except for
 * `makeRealRunner`.
 *
 * INVARIANT (plan hard constraint): nothing here imports from `src/core/**`,
 * and `src/core/**` never imports this. Spawning lives only in `src/runtime/**`.
 */

import { spawn } from 'node:child_process';

/**
 * A fully-resolved request to run one external script. The command layer
 * produces this; the Runner consumes it. Everything is explicit so a fake
 * Runner can assert on it byte-for-byte.
 */
export interface ScriptInvocation {
  /** Working directory the script runs in (the synthetic-dev dir). */
  cwd: string;
  /** Absolute path (or resolvable command) to execute, e.g. up.sh's path. */
  command: string;
  /** argv handed to `command`, already mapped from CLI flags. */
  args: string[];
  /**
   * Extra/override env vars layered ON TOP of the parent environment by the
   * real runner (the sibling-repo path vars from `repos.ts`, etc.). A fake
   * runner records exactly this map — it does NOT see the inherited parent env.
   */
  env: Record<string, string>;
  /**
   * stdio policy. Only `'inherit'` is meaningful for the M1 wrappers (the bash
   * scripts are interactive / stream progress straight to the user's TTY).
   * Defaults to `'inherit'` in the real runner.
   */
  stdio?: 'inherit';
}

/** The result of running a script: just the process exit code. */
export interface RunResult {
  code: number;
}

/**
 * The injectable process seam. One method, returns the child's exit code.
 * Production wires `makeRealRunner()`; tests pass a fake that records the spec.
 */
export interface Runner {
  run(spec: ScriptInvocation): Promise<RunResult>;
}

/**
 * The production Runner: `spawn` the command with stdio inherited (default) so
 * the bash script owns the user's terminal, and resolve with its exit code.
 *
 * Env is the parent `process.env` with `spec.env` layered on top, so up.sh sees
 * the user's shell environment PLUS the CLI's per-repo path overrides. A
 * spawn-level failure (e.g. ENOENT — script missing/not executable) rejects.
 */
export function makeRealRunner(): Runner {
  return {
    run(spec: ScriptInvocation): Promise<RunResult> {
      return new Promise<RunResult>((resolve, reject) => {
        const child = spawn(spec.command, spec.args, {
          cwd: spec.cwd,
          env: { ...process.env, ...spec.env },
          stdio: spec.stdio ?? 'inherit',
        });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code: code ?? 0 }));
      });
    },
  };
}
