/**
 * `stack seed` NATIVE seed-runner integration tests (FLIP 2).
 *
 * FLIP 2 makes bare `stack seed` seed an already-running stack NATIVELY: build the
 * SeedSelection (profile + `--with` add-ons) → composeSeedPlan over the running
 * stack's active service set → run it through the SAME `StackApi.seed` runner the
 * `stack up --only` path uses. NO up.sh, no prep, no mesh, no launch — `stack seed`
 * is fully native.
 *
 * These drive the REAL StackSeed command end-to-end but replace the process seam
 * (`getRunner`) with a fake that records each seed step — so the composed plan +
 * profile/add-on mapping are asserted WITHOUT spawning pnpm/docker/up.sh.
 */

import { resolve } from 'node:path';
import { Config } from '@oclif/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseCommand } from '../../../base-command.js';
import type { RunResult, Runner, ScriptInvocation } from '../../../runtime/index.js';
import StackSeed from '../seed.js';

const PKG_ROOT = process.cwd();
const SOA_ROOT = resolve(PKG_ROOT, '..', '..', '..');
const DEV_ROOT = '/fixed/dev';
const WS = ['--soa', SOA_ROOT, '--dev', DEV_ROOT];

let config: Config;
let runs: ScriptInvocation[];
let logged: string[];

/** Install a fake Runner on the prototype; record every invocation, answer 0. */
function installRunner(fail?: (spec: ScriptInvocation) => boolean): void {
  runs = [];
  vi.spyOn(
    BaseCommand.prototype as unknown as { getRunner: () => Runner },
    'getRunner',
  ).mockReturnValue({
    async run(spec: ScriptInvocation): Promise<RunResult> {
      runs.push(spec);
      return { code: fail?.(spec) ? 1 : 0 };
    },
  });
}

/** Parse the `--output-json` object the command emitted. */
function seededJson(): { offline: string[]; online: string[]; ok: boolean; native: boolean } {
  const line = logged.find((l) => l.trim().startsWith('{'));
  if (!line) throw new Error(`no JSON emitted; logged: ${logged.join('\n')}`);
  return JSON.parse(line) as { offline: string[]; online: string[]; ok: boolean; native: boolean };
}

/** All seed-step ids that RAN (offline ∪ online). */
function ranIds(): Set<string> {
  const j = seededJson();
  return new Set([...j.offline, ...j.online]);
}

beforeEach(async () => {
  config = await Config.load(PKG_ROOT);
  installRunner();
  logged = [];
  vi.spyOn(BaseCommand.prototype, 'log').mockImplementation((m?: string) => {
    logged.push(String(m ?? ''));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('stack seed — native seed runner (FLIP 2)', () => {
  it('bare: seeds the roster profile natively through StackApi.seed — NEVER up.sh', async () => {
    await StackSeed.run(['--output-json', ...WS], config);

    // native — never resolved/ran the up.sh wrapper.
    expect(runs.some((r) => r.command.endsWith('up.sh'))).toBe(false);
    // the roster seed steps ran through the Runner (dev-user + iam/sessions db:seed).
    expect(runs.some((r) => r.args.some((a) => a.includes('seed-dev-user')))).toBe(true);
    expect(runs.some((r) => r.args.includes('db:seed'))).toBe(true);

    // roster profile: iam-dev-user + iam + sessions; NOT the full-only steps.
    const ids = ranIds();
    expect(ids).toContain('iam-dev-user');
    expect(ids).toContain('iam');
    expect(ids).toContain('sessions');
    expect(ids).not.toContain('content');
    expect(ids).not.toContain('programs');
    expect(seededJson().native).toBe(true);
    expect(seededJson().ok).toBe(true);
  });

  it('full: composes the full-profile steps (programs/scheduling/content/coach) — still native', async () => {
    await StackSeed.run(['full', '--output-json', ...WS], config);
    expect(runs.some((r) => r.command.endsWith('up.sh'))).toBe(false);

    const ids = ranIds();
    // roster base ∪ the full-only additions.
    expect(ids).toContain('iam-dev-user');
    expect(ids).toContain('programs');
    expect(ids).toContain('scheduling');
    expect(ids).toContain('content');
    expect(ids).toContain('coach-pg');
  });

  it('--with qtf: layers the qtf-demo add-on step onto the plan', async () => {
    await StackSeed.run(['--with', 'qtf', '--output-json', ...WS], config);
    expect(runs.some((r) => r.command.endsWith('up.sh'))).toBe(false);
    // the qtf demo seed step ran (its own db:seed:qtf-demo script).
    expect(runs.some((r) => r.args.includes('db:seed:qtf-demo'))).toBe(true);
    expect(ranIds()).toContain('qtf-demo');
  });

  it('--with playback: pulls the playback trio into the active set + seeds them', async () => {
    await StackSeed.run(['--with', 'playback', '--output-json', ...WS], config);
    expect(runs.some((r) => r.command.endsWith('up.sh'))).toBe(false);
    // playback fixture steps (transcripts/insights/chat) composed + ran.
    const ids = ranIds();
    expect(ids).toContain('transcripts');
    expect(ids).toContain('insights');
    expect(ids).toContain('chat');
  });

  it('a bundle with no seed add-on (--with coach) is a no-op on the plan (roster baseline)', async () => {
    await StackSeed.run(['--with', 'coach', '--output-json', ...WS], config);
    const ids = ranIds();
    expect(ids).toContain('iam-dev-user');
    expect(ids).not.toContain('content'); // still roster
    expect(ids).not.toContain('qtf-demo');
  });

  it('exits non-zero when a fatal seed step fails (surfaced, native)', async () => {
    // Fail the iam db:seed (a fatal step) — the native seed run must exit 1.
    installRunner((spec) => spec.command === 'pnpm' && spec.args.includes('db:seed') && spec.cwd.includes('iam'));
    logged = [];
    vi.spyOn(BaseCommand.prototype, 'log').mockImplementation((m?: string) => {
      logged.push(String(m ?? ''));
    });
    await expect(StackSeed.run([...WS], config)).rejects.toMatchObject({ oclif: { exit: 1 } });
    expect(runs.some((r) => r.command.endsWith('up.sh'))).toBe(false);
  });
});

describe('stack seed — multi-seed datasets (#221)', () => {
  it('full --scenario ab-topology: stamps SEED_DATASET onto the triad seed runs only', async () => {
    await StackSeed.run(['full', '--scenario', 'ab-topology', '--output-json', ...WS], config);
    expect(runs.some((r) => r.command.endsWith('up.sh'))).toBe(false);

    // The triad's db:seed runs carry the stamped var…
    const stamped = runs.filter((r) => r.env?.SEED_DATASET === 'ab-topology');
    expect(stamped.length).toBe(3); // programs + scheduling + sessions
    // …and the iam dev-user seed does NOT.
    const devUser = runs.find((r) => r.args.some((a) => a.includes('seed-dev-user')));
    expect(devUser?.env?.SEED_DATASET).toBeUndefined();
    expect(seededJson().ok).toBe(true);
  });

  it('--dataset <system>=<name> stamps just that system', async () => {
    await StackSeed.run(['--dataset', 'sessions-api=alt', '--output-json', ...WS], config);
    const stamped = runs.filter((r) => r.env?.SEED_DATASET === 'alt');
    expect(stamped.length).toBe(1); // the sessions step only (roster profile)
  });

  it('--dry-run: prints the composed labeled plan and runs NOTHING', async () => {
    await StackSeed.run(['full', '--scenario', 'ab-topology', '--dry-run', '--output-json', ...WS], config);
    expect(runs).toEqual([]); // no seed step spawned
    const line = logged.find((l) => l.trim().startsWith('{'));
    const j = JSON.parse(String(line)) as { dryRun: boolean; offline: string[]; scenario?: string };
    expect(j.dryRun).toBe(true);
    expect(j.scenario).toBe('ab-topology');
    expect(j.offline).toContain('programs [SEED_DATASET=ab-topology]');
    expect(j.offline).toContain('iam-dev-user'); // unstamped steps keep plain labels
  });

  it('rejects a malformed --dataset value', async () => {
    await expect(StackSeed.run(['--dataset', 'sessions-api', ...WS], config)).rejects.toThrow(
      /--dataset expects <system>=<name>/,
    );
    expect(runs).toEqual([]);
  });

  it('rejects an unknown --dataset service id, listing the known ids', async () => {
    await expect(StackSeed.run(['--dataset', 'nope-api=x', ...WS], config)).rejects.toThrow(
      /unknown service id 'nope-api'/,
    );
  });

  it('COHERENCE at the command layer: roster --scenario ab-topology errors (triad not selected)', async () => {
    // roster never selects programs/scheduling steps ⇒ the coupled scenario
    // cannot apply coherently ⇒ surfaced as a command error, nothing seeded.
    await expect(StackSeed.run(['--scenario', 'ab-topology', ...WS], config)).rejects.toThrow(
      /cannot be applied coherently/,
    );
    expect(runs).toEqual([]);
  });

  it('CONFLICT: --scenario plus a different --dataset for the same system errors', async () => {
    await expect(
      StackSeed.run(['full', '--scenario', 'ab-topology', '--dataset', 'programs-api=other', ...WS], config),
    ).rejects.toThrow(/conflicting datasets/);
    expect(runs).toEqual([]);
  });
});
