/**
 * M13-B implicit set preflight (BaseCommand.runSetPreflight — wired into
 * `stack up --set` and `e2e run --set`): violations hard-error BEFORE any
 * stack mutation; `--allow-primary` downgrades the primary-checkout refusal
 * to a warning; the cross-set collision is sharpened with live ACTIVE-slot
 * detection. Exercised through a zero-IO probe command (parse + preflight
 * only — makeProbeCommand with preflight: true) plus the real `e2e run`
 * (whose preflight fires before any discovery). Seams faked via the shared
 * set-fakes helpers.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Config } from '@oclif/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  makeProbeCommand,
  oneSetWithSagaDash,
  spyGitRunner,
  spyPrepFresh,
  spySetStore,
  spySlotActive,
  twoSetsSharingCheckout,
} from '../../../__tests__/helpers/set-fakes.js';
import { BaseCommand } from '../../../base-command.js';
import E2eRun from '../../e2e/run.js';

const PKG_ROOT = process.cwd();

/** Zero-IO probe: parse + the M13-B preflight, nothing else. */
const PreflightProbe = makeProbeCommand({ setAware: true, allowPrimary: true, preflight: true });

let config: Config;
let dir: string;
let logged: string[];

beforeEach(async () => {
  config = await Config.load(PKG_ROOT);
  dir = mkdtempSync(join(tmpdir(), 'set-preflight-'));
  logged = [];
  vi.spyOn(BaseCommand.prototype, 'log').mockImplementation((m) => {
    logged.push(String(m ?? ''));
  });
  spySlotActive([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('runSetPreflight violations', () => {
  it('a missing path hard-errors before anything runs', async () => {
    spySetStore(oneSetWithSagaDash(join(dir, 'nope')));
    spyGitRunner();
    spyPrepFresh(true);
    await expect(PreflightProbe.run(['--set', 'x', '--dev', join(dir, 'dev')], config)).rejects.toThrow(
      /failed the preflight check[\s\S]*path does not exist/,
    );
  });

  it('a BUILDABLE entry at the primary checkout is refused — --allow-primary downgrades to a warning', async () => {
    const devRoot = join(dir, 'dev');
    const primary = join(devRoot, 'saga-dash');
    mkdirSync(primary, { recursive: true });
    spySetStore(oneSetWithSagaDash(primary));
    spyGitRunner();
    spyPrepFresh(false);

    await expect(PreflightProbe.run(['--set', 'x', '--dev', devRoot], config)).rejects.toThrow(
      /BUILDABLE entry points at the primary checkout/,
    );

    await expect(
      PreflightProbe.run(['--set', 'x', '--dev', devRoot, '--allow-primary'], config),
    ).resolves.toBeUndefined();
    expect(logged.join('\n')).toMatch(/⚠ set x\/saga-dash: BUILDABLE entry at the primary checkout — allowed/);
  });

  it('a cross-set buildable collision names the other set — and flags it ACTIVE when its slot is live', async () => {
    const shared = join(dir, 'shared');
    mkdirSync(shared);
    spySetStore(twoSetsSharingCheckout(shared));
    spyGitRunner();
    spyPrepFresh(false);
    spySlotActive(['soa-s2']); // set b's slot is LIVE

    await expect(PreflightProbe.run(['--set', 'a', '--dev', join(dir, 'dev')], config)).rejects.toThrow(
      /build collision: set 'b' rostering[\s\S]*slot 2\) is ACTIVE right now/,
    );
  });

  it('no --set = no-op (nothing loaded, nothing logged)', async () => {
    // Store spy intentionally NOT installed: a load would throw on real fs read
    // of a nonexistent canned path — the no-op must never get that far.
    spyGitRunner();
    spyPrepFresh(true);
    await expect(PreflightProbe.run(['--dev', join(dir, 'dev')], config)).resolves.toBeUndefined();
  });
});

describe('e2e run --set runs the preflight before discovery', () => {
  it('a violating set fails e2e run up front', async () => {
    spySetStore(oneSetWithSagaDash(join(dir, 'nope')));
    spyGitRunner();
    spyPrepFresh(true);
    await expect(
      E2eRun.run(['saga-dash/journey', '--set', 'x', '--dev', join(dir, 'dev')], config),
    ).rejects.toThrow(/failed the preflight check/);
  });
});
