/**
 * `develop connect --tunnel --bootstrap` — the two-phase-bridge step sequencer
 * (soa#329, decisions recorded on the issue).
 *
 * WHY two phases: one iam serves EITHER localhost OR the tunnel hosts, never
 * both (AUTH_SESSIONCOOKIEDOMAIN is baked into the launch env — docs/tunnel.md's
 * cookie-domain physics). So usable tunnel state is built LOCALLY first (fast,
 * tested), snapshotted, and then RESTORED over a tunnel-mode relaunch:
 *
 *   PHASE 1 (local):  down → up --seed full --reset → journey prerequisite
 *                     (checkpoint restore if usable, else headless replay;
 *                     retry-once on the known async-settle stage-flake class) →
 *                     settle barrier → snapshot store tunnel-connect --force
 *   PHASE 2 (tunnel): down → up --tunnel --reset --forbid-foreign (HARD STOP
 *                     when a foreign process survived — phase-2 correctness
 *                     DEPENDS on every service relaunching with the tunnel env)
 *                     → snapshot restore tunnel-connect → persona preflight
 *                     (the soa#331 devLogin probe) → hand off to the existing
 *                     `--reuse` live-session path.
 *
 * This module owns the SEQUENCING (ledger consult/record around every step, the
 * fixture fast-path decision, the failure/resume messages); the STEPS themselves
 * are closures the command builds over the existing facades/sub-commands. Ledger
 * fs IO stays behind the injectable `BootstrapLedgerIO` seam (runtime/**), so
 * everything here is unit-testable with fakes. Lives at src ROOT (not under
 * `commands/`) for the same reason as e2e-orchestrate.ts: oclif treats every
 * file under `commands/` as a command, and `oclif manifest` fails on a module.
 *
 * FAILURE CONTRACT: stop at the failed step, keep the ledger, print it plus the
 * exact command that resumes. NEVER auto-teardown — half-built state is
 * debugging evidence.
 */

import { CHECKPOINT_MAX_AGE_DAYS } from './core/flow/index.js';
import type { SnapshotManifest } from './core/snapshot/index.js';
import { REPO_ENV_VAR } from './runtime/index.js';
import type { BootstrapLedger, BootstrapLedgerIO } from './runtime/index.js';
import type { WorkspaceFlags } from './base-command.js';

/** The snapshot fixture the bridge stores/restores (docs/tunnel.md's name). */
export const TUNNEL_CONNECT_FIXTURE_ID = 'tunnel-connect';

/** The exact command a failed bootstrap tells the user to re-run (it resumes). */
export const BOOTSTRAP_RESUME_COMMAND = 'ss develop connect --tunnel --bootstrap';

/** One sequencer step: a stable ledger id, a human title, and the work. */
export interface BootstrapStep {
  /** Stable id — the ledger key. NEVER renumber/rename without a ledger version bump. */
  id: string;
  /** Human-first progress line (matches `up`'s emit style). */
  title: string;
  run(): Promise<void>;
}

/** What the sequencer needs beyond the steps (all injectable). */
export interface BootstrapRunDeps {
  ledger: BootstrapLedgerIO;
  ledgerPath: string;
  log: (line: string) => void;
  now: Date;
}

/** A step failure, message pre-built with the ledger + resume remediation. */
export class BootstrapStepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BootstrapStepError';
  }
}

/**
 * FAST-PATH decision: phase 1 is skippable iff a tunnel-connect fixture exists,
 * parses, and its `createdAt` is younger than the checkpoint staleness cliff
 * (7d — the SAME constant the M14 checkpoints use, so "fresh" means one thing).
 * `--rebuild` overrides at the caller.
 */
export function tunnelFixtureFresh(manifest: SnapshotManifest | null, now: Date): boolean {
  if (manifest === null || manifest.createdAt === undefined) return false;
  const created = Date.parse(manifest.createdAt);
  if (Number.isNaN(created)) return false;
  const ageDays = (now.getTime() - created) / 86_400_000;
  return ageDays < CHECKPOINT_MAX_AGE_DAYS;
}

/**
 * Run the steps with the ledger consulted BEFORE and written AFTER each one:
 * a step recorded as completed by a previous (failed) run is skipped, every
 * fresh success is persisted immediately, and the ledger is cleared ONLY when
 * every step completed. A step failure throws `BootstrapStepError` carrying the
 * ledger state + the resume command; nothing is torn down.
 */
export async function runBootstrapSteps(steps: BootstrapStep[], deps: BootstrapRunDeps): Promise<void> {
  const existing = deps.ledger.read(deps.ledgerPath);
  let ledger: BootstrapLedger =
    existing ?? { version: 1, startedAt: deps.now.toISOString(), completed: [] };
  if (existing !== null && existing.completed.length > 0) {
    deps.log(
      `==> bootstrap: RESUMING — ${deps.ledgerPath} records ${existing.completed.length} ` +
        `completed step(s) from ${existing.startedAt}: ${existing.completed.join(', ')}`,
    );
  }

  const done = new Set(ledger.completed);
  for (const [i, step] of steps.entries()) {
    const label = `${i + 1}/${steps.length} ${step.title}`;
    if (done.has(step.id)) {
      deps.log(`▶ ${label} — SKIPPED (ledger: already completed)`);
      continue;
    }
    deps.log(`▶ ${label}`);
    try {
      await step.run();
    } catch (err) {
      // Keep the ledger (it already records everything BEFORE this step) and
      // stop. No teardown: the half-built state is what the user debugs.
      throw new BootstrapStepError(
        bootstrapFailureMessage(step, ledger, deps.ledgerPath, (err as Error).message ?? String(err)),
      );
    }
    ledger = { ...ledger, completed: [...ledger.completed, step.id] };
    deps.ledger.write(deps.ledgerPath, ledger);
  }

  // Success only: the next --bootstrap starts from a clean ledger (the fixture
  // fast-path, not the ledger, is what makes IT fast).
  deps.ledger.clear(deps.ledgerPath);
}

/** The stop-and-resume message a failed step surfaces (pure; unit-tested). */
export function bootstrapFailureMessage(
  step: BootstrapStep,
  ledger: BootstrapLedger,
  ledgerPath: string,
  cause: string,
): string {
  return [
    `bootstrap FAILED at step '${step.id}' (${step.title}):`,
    cause.replace(/^/gm, '  '),
    '',
    `ledger (${ledgerPath}) — kept, nothing torn down (the half-built state is debugging evidence):`,
    `  completed: ${ledger.completed.join(', ') || '(none)'}`,
    `  failed:    ${step.id}`,
    '',
    `Fix the cause, then resume from '${step.id}' with:`,
    `  ${BOOTSTRAP_RESUME_COMMAND}`,
  ].join('\n');
}

/**
 * Reconstruct the workspace-resolution argv (`--dev` + per-repo pins +
 * `--state-dir`) forwarded to the phase sub-commands (`stack down/up`,
 * `snapshot store/restore`) so they resolve the SAME checkouts + state dir this
 * connect run did — the `stack bootstrap` precedent (workspaceArgs there).
 */
export function bootstrapWorkspaceArgv(flags: WorkspaceFlags & { 'state-dir'?: string }): string[] {
  const args: string[] = [];
  if (flags.dev) args.push('--dev', flags.dev);
  for (const kebab of Object.keys(REPO_ENV_VAR) as (keyof typeof REPO_ENV_VAR)[]) {
    const value = (flags as unknown as Record<string, string | undefined>)[kebab];
    if (value) args.push(`--${kebab}`, value);
  }
  if (flags['state-dir']) args.push('--state-dir', flags['state-dir']);
  return args;
}
