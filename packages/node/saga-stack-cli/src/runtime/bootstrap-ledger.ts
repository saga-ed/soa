/**
 * Bootstrap ledger (soa#329 `develop connect --bootstrap`) — the on-disk record
 * of which two-phase-bridge steps have completed, written to
 * `<stateDir>/bootstrap.json` after EVERY successful step so a failed run can
 * RESUME at the failed step instead of rebuilding the world. The sequencer
 * (commands/develop/bootstrap-connect.ts) NEVER auto-tears-down on failure —
 * half-built state is debugging evidence — so the ledger is the only thing that
 * carries progress across runs. It is cleared ONLY when every step completed.
 *
 * fs IO lives HERE (src/runtime/** owns real IO); the sequencer consumes it only
 * through the injectable `BootstrapLedgerIO` seam (the CoachWebFs/settle-barrier
 * seam precedent), so its resume/clear logic is unit-testable with a fake.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The on-disk `bootstrap.json` shape. */
export interface BootstrapLedger {
  version: 1;
  /** ISO timestamp of the run that STARTED this ledger (resumes keep it). */
  startedAt: string;
  /** Step ids completed so far, in completion order. */
  completed: string[];
}

/** The injectable ledger-IO seam (`BaseCommand.getBootstrapLedgerIO`). */
export interface BootstrapLedgerIO {
  /** Read + shape-check the ledger; null when absent/corrupt (corrupt ⇒ start over). */
  read(path: string): BootstrapLedger | null;
  /** Persist the ledger (mkdir -p the state dir first — a fresh slot has none). */
  write(path: string, ledger: BootstrapLedger): void;
  /** Remove the ledger (success-only; force so a missing file is a no-op). */
  clear(path: string): void;
}

/** The ledger's canonical location inside a slot's state dir. */
export function bootstrapLedgerPath(stateDir: string): string {
  return join(stateDir, 'bootstrap.json');
}

/** Production ledger IO — the only place bootstrap.json touches the real fs. */
export function makeRealBootstrapLedgerIO(): BootstrapLedgerIO {
  return {
    read(path: string): BootstrapLedger | null {
      if (!existsSync(path)) return null;
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        return null;
      }
      const l = raw as BootstrapLedger;
      // Minimal boundary check: a corrupt/foreign file must degrade to "no
      // ledger" (full run), never crash or resume from garbage step ids.
      if (
        l === null ||
        typeof l !== 'object' ||
        l.version !== 1 ||
        typeof l.startedAt !== 'string' ||
        !Array.isArray(l.completed) ||
        !l.completed.every((s) => typeof s === 'string')
      ) {
        return null;
      }
      return l;
    },
    write(path: string, ledger: BootstrapLedger): void {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(ledger, null, 2)}\n`);
    },
    clear(path: string): void {
      rmSync(path, { force: true });
    },
  };
}
