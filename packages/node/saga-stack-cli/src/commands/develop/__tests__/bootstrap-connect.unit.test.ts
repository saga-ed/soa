/**
 * Unit tests for the --bootstrap sequencer building blocks (soa#329): the
 * fixture fast-path freshness rule, the ledger-driven step sequencer
 * (skip/record/clear/resume semantics with a FAKE LedgerIO — no fs), the
 * failure/resume message, and the real ledger IO's corrupt-file boundary.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SnapshotManifest } from '../../../core/snapshot/index.js';
import {
  bootstrapLedgerPath,
  makeRealBootstrapLedgerIO,
} from '../../../runtime/index.js';
import type { BootstrapLedger, BootstrapLedgerIO } from '../../../runtime/index.js';
import {
  BOOTSTRAP_RESUME_COMMAND,
  BootstrapStepError,
  bootstrapFailureMessage,
  runBootstrapSteps,
  tunnelFixtureFresh,
} from '../../../bootstrap-connect.js';
import type { BootstrapStep } from '../../../bootstrap-connect.js';
import { forbidForeignMessage } from '../../stack/up.js';

const NOW = new Date('2026-07-16T12:00:00Z');

function manifestCreatedAt(iso: string | undefined): SnapshotManifest {
  return { createdAt: iso } as unknown as SnapshotManifest;
}

describe('tunnelFixtureFresh — the phase-1 fast-path decision', () => {
  it('null manifest (fixture absent/corrupt) is never fresh', () => {
    expect(tunnelFixtureFresh(null, NOW)).toBe(false);
  });

  it('a fixture younger than 7 days is fresh', () => {
    expect(tunnelFixtureFresh(manifestCreatedAt('2026-07-15T12:00:00Z'), NOW)).toBe(true); // 1d
    expect(tunnelFixtureFresh(manifestCreatedAt('2026-07-09T12:00:01Z'), NOW)).toBe(true); // 7d - 1s
  });

  it('a fixture at/over the 7-day cliff is stale (boundary excluded)', () => {
    expect(tunnelFixtureFresh(manifestCreatedAt('2026-07-09T12:00:00Z'), NOW)).toBe(false); // exactly 7d
    expect(tunnelFixtureFresh(manifestCreatedAt('2026-07-01T12:00:00Z'), NOW)).toBe(false); // 15d
  });

  it('a missing/unparseable createdAt is stale (rebuild rather than trust garbage)', () => {
    expect(tunnelFixtureFresh(manifestCreatedAt(undefined), NOW)).toBe(false);
    expect(tunnelFixtureFresh(manifestCreatedAt('not-a-date'), NOW)).toBe(false);
  });
});

/** A fake LedgerIO backed by a plain variable — records every write. */
function fakeLedgerIO(initial: BootstrapLedger | null = null): {
  io: BootstrapLedgerIO;
  writes: BootstrapLedger[];
  current: () => BootstrapLedger | null;
} {
  let state = initial;
  const writes: BootstrapLedger[] = [];
  return {
    io: {
      read: () => state,
      write: (_p, l) => {
        state = l;
        writes.push(l);
      },
      clear: () => {
        state = null;
      },
    },
    writes,
    current: () => state,
  };
}

function step(id: string, impl?: () => Promise<void>): BootstrapStep & { calls: number[] } {
  const calls: number[] = [];
  let n = 0;
  return {
    id,
    title: `step ${id}`,
    calls,
    run: async () => {
      n += 1;
      calls.push(n);
      if (impl) await impl();
    },
  };
}

describe('runBootstrapSteps — ledger sequencing', () => {
  const deps = (io: BootstrapLedgerIO, log: string[] = []) => ({
    ledger: io,
    ledgerPath: '/state/bootstrap.json',
    log: (l: string) => log.push(l),
    now: NOW,
  });

  it('runs every step in order, writes the ledger after EACH, and clears it on success', async () => {
    const { io, writes, current } = fakeLedgerIO();
    const a = step('a');
    const b = step('b');
    await runBootstrapSteps([a, b], deps(io));

    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);
    // Incremental persistence: a alone, then a+b — a crash between steps loses nothing.
    expect(writes.map((w) => w.completed)).toEqual([['a'], ['a', 'b']]);
    // Success clears (the fixture fast path, not the ledger, makes the NEXT run fast).
    expect(current()).toBeNull();
  });

  it('a step failure stops the run, KEEPS the ledger, and reports ledger + resume command', async () => {
    const { io, current } = fakeLedgerIO();
    const a = step('a');
    const boom = step('boom', async () => {
      throw new Error('psql exploded');
    });
    const never = step('never');

    await expect(runBootstrapSteps([a, boom, never], deps(io))).rejects.toThrow(BootstrapStepError);
    expect(never.calls).toHaveLength(0);
    expect(current()?.completed).toEqual(['a']); // kept, not cleared — nothing torn down

    const err = await runBootstrapSteps([a, boom, never], deps(io)).catch((e: Error) => e);
    expect((err as Error).message).toContain('psql exploded');
    expect((err as Error).message).toContain("failed:    boom");
    expect((err as Error).message).toContain(BOOTSTRAP_RESUME_COMMAND);
  });

  it('a re-run RESUMES: steps recorded completed are skipped, the failed step re-runs', async () => {
    const { io, current } = fakeLedgerIO({ version: 1, startedAt: 'x', completed: ['a', 'b'] });
    const a = step('a');
    const b = step('b');
    const c = step('c');
    const log: string[] = [];
    await runBootstrapSteps([a, b, c], deps(io, log));

    expect(a.calls).toHaveLength(0);
    expect(b.calls).toHaveLength(0);
    expect(c.calls).toHaveLength(1);
    expect(log.some((l) => l.includes('RESUMING'))).toBe(true);
    expect(current()).toBeNull(); // completed ⇒ cleared
  });

  it('recorded completions AFTER the resume point are stale: pruned (persisted) and re-run', async () => {
    // The cross-shape poisoning case: a failed FAST-PATH run recorded the
    // phase-2 ids ('c','d'); the re-run has the FULL shape and must not skip
    // them after re-executing the phase-1 steps ('a','b') underneath them.
    const { io, writes } = fakeLedgerIO({ version: 1, startedAt: 'x', completed: ['c', 'd'] });
    const a = step('a');
    const b = step('b');
    const c = step('c');
    const d = step('d');
    const log: string[] = [];
    await runBootstrapSteps([a, b, c, d], deps(io, log));

    for (const s of [a, b, c, d]) expect(s.calls).toHaveLength(1);
    expect(log.some((l) => l.includes('invalidated'))).toBe(true);
    // The prune itself is persisted BEFORE any step runs, so a crash mid-run
    // cannot resurrect the stale ids in a later differently-shaped resume.
    expect(writes[0]?.completed).toEqual([]);
  });

  it('recorded completions BEFORE the resume point (even from another shape) still skip', async () => {
    // Full-run failure at 'c' then a fast-path-shaped resume [b, c, d]: 'b' is
    // a valid leading prefix — only ids AFTER the first un-recorded step die.
    const { io } = fakeLedgerIO({ version: 1, startedAt: 'x', completed: ['a', 'b'] });
    const b = step('b');
    const c = step('c');
    const d = step('d');
    await runBootstrapSteps([b, c, d], deps(io));

    expect(b.calls).toHaveLength(0);
    expect(c.calls).toHaveLength(1);
    expect(d.calls).toHaveLength(1);
  });
});

describe('bootstrapFailureMessage', () => {
  it('names the failed step, embeds the cause, prints the ledger and the exact resume command', () => {
    const msg = bootstrapFailureMessage(
      { id: 'tunnel-up', title: 'phase 2 — up', run: async () => {} },
      { version: 1, startedAt: 't0', completed: ['local-down', 'local-up'] },
      '/tmp/sds-synthetic/bootstrap.json',
      'up exploded',
    );
    expect(msg).toContain("bootstrap FAILED at step 'tunnel-up'");
    expect(msg).toContain('up exploded');
    expect(msg).toContain('completed: local-down, local-up');
    expect(msg).toContain('/tmp/sds-synthetic/bootstrap.json');
    expect(msg).toContain(BOOTSTRAP_RESUME_COMMAND);
    // The contract: NOTHING is torn down on failure.
    expect(msg).toContain('nothing torn down');
  });
});

describe('makeRealBootstrapLedgerIO — fs boundary', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('round-trips a ledger, mkdir -p on write, and clear removes it', () => {
    dir = mkdtempSync(join(tmpdir(), 'saga-bootstrap-ledger-'));
    const path = bootstrapLedgerPath(join(dir, 'deep', 'state')); // parent does not exist yet
    const io = makeRealBootstrapLedgerIO();
    expect(io.read(path)).toBeNull();

    const ledger: BootstrapLedger = { version: 1, startedAt: NOW.toISOString(), completed: ['local-down'] };
    io.write(path, ledger);
    expect(io.read(path)).toEqual(ledger);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(ledger);

    io.clear(path);
    expect(existsSync(path)).toBe(false);
    io.clear(path); // idempotent
  });

  it('a corrupt/foreign bootstrap.json degrades to null (full run), never a crash', () => {
    dir = mkdtempSync(join(tmpdir(), 'saga-bootstrap-ledger-'));
    const path = bootstrapLedgerPath(dir);
    const io = makeRealBootstrapLedgerIO();

    writeFileSync(path, 'not json');
    expect(io.read(path)).toBeNull();
    writeFileSync(path, JSON.stringify({ version: 2, startedAt: 'x', completed: [] }));
    expect(io.read(path)).toBeNull();
    writeFileSync(path, JSON.stringify({ version: 1, startedAt: 'x', completed: [1, 2] }));
    expect(io.read(path)).toBeNull();
  });
});

describe('forbidForeignMessage (stack up --forbid-foreign, the phase-2 hard stop)', () => {
  it('lists each foreign service with its port + the lsof that reveals the pid, and the resume remediation', () => {
    const msg = forbidForeignMessage(['programs-api', 'iam-api'], { 'programs-api': 4011, 'iam-api': 3010 });
    expect(msg).toContain('adopted 2 process(es) NOT launched by this CLI');
    expect(msg).toContain('programs-api (port 4011)');
    expect(msg).toContain('lsof -nP -iTCP:4011 -sTCP:LISTEN');
    expect(msg).toContain('iam-api (port 3010)');
    expect(msg).toContain('relaunch');
    expect(msg).toContain('ledger resumes at this step');
  });

  it('degrades to a health-URL hint when a service has no resolved port', () => {
    const msg = forbidForeignMessage(['iam-api'], {});
    expect(msg).toContain('no resolved port');
  });
});
