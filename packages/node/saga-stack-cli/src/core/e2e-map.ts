/**
 * PURE flag→invocation mappers for the `e2e` topic (plan §3.2, §7.2 "M2").
 *
 * Mirrors `flag-map.ts` (the `stack` topic) but for the saga-dash e2e bash, and
 * kept in its OWN module so the two topics' mappers never share a file. Each
 * mapper returns the exact `{ script, args, env }` for the corresponding script,
 * transcribed flag-for-flag from its arg parser. NOTHING here spawns, touches
 * the network, or reads the filesystem — it stays PURE for golden argv/env tests.
 *
 * The e2e scripts live in the SAGA_DASH repo (NOT soa's synthetic-dev), so the
 * locators name `repo: 'SAGA_DASH'`; the runtime resolves `<SAGA_DASH>/apps/web/
 * dash/e2e/<script>` and runs it from that dir.
 *
 * M2 SCOPE (faithful thin wrap of today's bash):
 *   - `e2e run`     → check-e2e.sh (the stack-lane journey concierge; -p/--phase,
 *                     --headless, env knobs SKIP_RESET/INSPECT/PAUSE_AT_END/
 *                     INSPECT_USER, + playwright passthrough). The DEPLOYED
 *                     sandbox lane (run-stack-e2e.sh --sandbox / janus / preview-
 *                     pins) and the native phase→project map are M5 (flow
 *                     registry) — out of scope here.
 *   - `e2e list`    → check-e2e.sh --help (the canonical phase table lives in the
 *                     bash today; the `flows.json` registry is M5).
 *   - `e2e connect` → connect-session.sh (foreground live-session hold).
 *
 * GROUND TRUTH: check-e2e.sh arg loop (~93-111) + env knobs (~67-68); connect-
 * session.sh arg loop (~33-39, `--reuse`/`--skip-build`).
 */

import type { ScriptLocator, ScriptPlan } from './flag-map.js';

/** Repo-relative dir holding the saga-dash e2e bash scripts. */
export const DASH_E2E_DIR = 'apps/web/dash/e2e';

/** Locator builder for a script in saga-dash's `apps/web/dash/e2e/` dir. */
export function dashE2eScript(name: string): ScriptLocator {
  return { repo: 'SAGA_DASH', relPath: `${DASH_E2E_DIR}/${name}` };
}

/** `e2e run` options (normalized to camelCase by the command layer). */
export interface E2eRunFlags {
  /** `--phase <name|n>` / `--through <phase>` → check-e2e.sh `--phase <p>` (runs 1..N). */
  phase?: string;
  /** `--headless` → check-e2e.sh `--headless` (default is headed/foreground). */
  headless?: boolean;
  /** `--skip-reset` → env SKIP_RESET=1 (reuse the current stack state). */
  skipReset?: boolean;
  /** `--inspect` → env INSPECT=1 (open a logged-in browser after the suite). */
  inspect?: boolean;
  /** `--no-inspect` → env INSPECT=0 (stay headed but skip the inspect browser). */
  noInspect?: boolean;
  /** `--pause-at-end` → env PAUSE_AT_END=1 (pause inside each test at its final state). */
  pauseAtEnd?: boolean;
  /** `--inspect-user <email>` → env INSPECT_USER. */
  inspectUser?: string;
  /** Trailing playwright args after `--` (passed through verbatim). */
  passthrough?: string[];
}

/**
 * `e2e run` → check-e2e.sh.
 *
 * `--phase` and `--headless` are check-e2e.sh argv; the lifecycle knobs are ENV
 * (check-e2e.sh inherits them down to run-stack-e2e.sh — see its header ~7-8),
 * mirroring how up.sh's `--no-auto-pull`/`--skip-prep` are env, not flags.
 */
export function e2eRun(flags: E2eRunFlags = {}): ScriptPlan {
  const args: string[] = [];
  if (flags.phase !== undefined) args.push('--phase', flags.phase);
  if (flags.headless) args.push('--headless');
  if (flags.passthrough?.length) args.push(...flags.passthrough);

  const env: Record<string, string> = {};
  if (flags.skipReset) env.SKIP_RESET = '1';
  if (flags.inspect) env.INSPECT = '1';
  if (flags.noInspect) env.INSPECT = '0';
  if (flags.pauseAtEnd) env.PAUSE_AT_END = '1';
  if (flags.inspectUser !== undefined) env.INSPECT_USER = flags.inspectUser;

  return { script: dashE2eScript('check-e2e.sh'), args, env };
}

/**
 * `e2e list` → check-e2e.sh `--help`. The phase table (num/name/project/status)
 * is hard-coded in check-e2e.sh today, so `--help` is the canonical listing; the
 * richer `--flows`/`--projects` modes arrive with the M5 flow registry.
 */
export function e2eList(): ScriptPlan {
  return { script: dashE2eScript('check-e2e.sh'), args: ['--help'], env: {} };
}

/** `e2e connect` options. */
export interface E2eConnectFlags {
  /** `--reuse` / `--skip-build` → connect-session.sh `--reuse` (skip the rebuild). */
  reuse?: boolean;
  /** Trailing playwright args after `--` (e.g. --debug, --timeout=0). */
  passthrough?: string[];
}

/**
 * `e2e connect` → connect-session.sh (FOREGROUND: the 3 browser windows are held
 * open by `page.pause()`; stdio is inherited so the hold owns the user's TTY).
 */
export function e2eConnect(flags: E2eConnectFlags = {}): ScriptPlan {
  const args: string[] = [];
  if (flags.reuse) args.push('--reuse');
  if (flags.passthrough?.length) args.push(...flags.passthrough);
  return { script: dashE2eScript('connect-session.sh'), args, env: {} };
}
