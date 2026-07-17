/**
 * `stack up --forbid-foreign` (soa#329 — the bootstrap phase-2 hard stop):
 * the REAL StackUp command with the core seam battery, whose launcher is
 * re-spied to ADOPT a foreign process (already-up, no pidfile). The hidden flag
 * escalates the report-time adoption warning into a hard abort BEFORE
 * reset/seed run; without the flag the warning path is byte-identical.
 */

import { resolve } from 'node:path';
import { Config } from '@oclif/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseCommand } from '../../../base-command.js';
import type {
  LaunchResult,
  LaunchSpec,
  ScriptInvocation,
  ServiceLauncher,
  StopResult,
} from '../../../runtime/index.js';
import { installCoreSeams } from '../../../__tests__/helpers/seams.js';
import StackUp from '../up.js';

const PKG_ROOT = process.cwd();
const SOA_ROOT = resolve(PKG_ROOT, '..', '..', '..');
const WS = ['--soa', SOA_ROOT, '--dev', '/fixed/dev'];

let config: Config;
let runs: ScriptInvocation[];
let warns: string[];

/** Re-spy the launcher so `foreign` ids come back adopted-foreign (alreadyUp, no pidfile). */
function foreignLauncher(foreign: Set<string>, pidBase = 5000): void {
  let n = 0;
  const launcher: ServiceLauncher = {
    async launch(spec: LaunchSpec): Promise<LaunchResult> {
      n += 1;
      return foreign.has(spec.id)
        ? { id: spec.id, ok: true, alreadyUp: true, adoptedForeign: true }
        : { id: spec.id, ok: true, pid: pidBase + n };
    },
    async stopServices(ids: string[]): Promise<StopResult[]> {
      return ids.map((id) => ({ id, stopped: true }));
    },
  };
  vi.spyOn(
    BaseCommand.prototype as unknown as { getLauncher: () => ServiceLauncher },
    'getLauncher',
  ).mockReturnValue(launcher);
}

beforeEach(async () => {
  config = await Config.load(PKG_ROOT);
  runs = installCoreSeams({ pidBase: 2000, prepFresh: true }).runs;
  warns = [];
  vi.spyOn(BaseCommand.prototype, 'log').mockImplementation(() => {});
  vi.spyOn(BaseCommand.prototype, 'warn').mockImplementation(((m: string) => {
    warns.push(m);
    return m;
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('stack up --forbid-foreign', () => {
  it('hard-errors on a foreign adoption, naming the service + its port lsof, BEFORE seed runs', async () => {
    foreignLauncher(new Set(['iam-api']));

    await expect(StackUp.run(['--only', 'iam-api', '--forbid-foreign', ...WS], config)).rejects.toThrow(
      /adopted 1 process\(es\) NOT launched by this CLI[\s\S]*iam-api \(port 3010\)[\s\S]*lsof -nP -iTCP:3010/,
    );

    // The abort fires BEFORE the seed phase — a foreign iam must not be seeded against.
    expect(runs.some((r) => r.args.some((a) => a.includes('db:seed')))).toBe(false);
  });

  it('WITHOUT the flag the same adoption stays the existing WARNING (up completes + seeds)', async () => {
    foreignLauncher(new Set(['iam-api']));

    await StackUp.run(['--only', 'iam-api', ...WS], config);

    expect(warns.some((w) => w.includes('NOT launched by this CLI'))).toBe(true);
    expect(runs.some((r) => r.args.some((a) => a.includes('db:seed')))).toBe(true);
  });

  it('with the flag but NO foreign adoption, up completes normally (the gate keys on adoptedForeign)', async () => {
    await StackUp.run(['--only', 'iam-api', '--forbid-foreign', ...WS], config);

    expect(runs.some((r) => r.args.some((a) => a.includes('db:seed')))).toBe(true);
  });
});
