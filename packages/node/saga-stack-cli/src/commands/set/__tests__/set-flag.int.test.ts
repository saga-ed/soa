/**
 * Central --set guard + parse-choke-point injection (M13-A, plan §2-§3).
 *
 * Mirrors slot-guard.unit.test.ts: real command classes, in-process, the
 * set-store seam spied on the prototype. The injection itself is asserted
 * through a minimal probe command (slot/set-aware, records its parsed flags,
 * zero IO) — every real command reads the same parsed bag, so what the probe
 * sees is what up/status/e2e/… see.
 */

import { resolve } from 'node:path';
import { Config } from '@oclif/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseCommand } from '../../../base-command.js';
import { parseWorktreeSetsFile } from '../../../core/set/index.js';
import type { SetStore } from '../../../runtime/index.js';
import StackRestart from '../../stack/restart.js';

const PKG_ROOT = process.cwd();
const SOA_ROOT = resolve(PKG_ROOT, '..', '..', '..');
const WS = ['--soa', SOA_ROOT, '--dev', '/fixed/dev'];

/** Canned store: journey-fix@1, topology@2 (saga-dash + rostering pinned). */
function cannedStore(): SetStore {
  return {
    path: () => '/canned/worktree-sets.json',
    load: () =>
      parseWorktreeSetsFile({
        version: 1,
        sets: {
          'journey-fix': { slot: 1, repos: { 'saga-dash': '/set/dash-journey' } },
          topology: { slot: 2, repos: { 'saga-dash': '/set/dash-topology', rostering: '/set/rostering-c' } },
        },
      }),
  };
}

/** Zero-IO probe: slot/set-aware, records the post-injection flags. */
class SetProbe extends BaseCommand {
  static flags = { ...BaseCommand.baseFlags };
  static captured: Record<string, unknown> = {};

  protected slotAware(): boolean {
    return true;
  }

  protected setAware(): boolean {
    return true;
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(SetProbe);
    SetProbe.captured = flags as Record<string, unknown>;
  }
}

let config: Config;

beforeEach(async () => {
  config = await Config.load(PKG_ROOT);
  SetProbe.captured = {};
  vi.spyOn(BaseCommand.prototype, 'log').mockImplementation(() => {});
  vi.spyOn(
    BaseCommand.prototype as unknown as { getSetStore: () => SetStore },
    'getSetStore',
  ).mockReturnValue(cannedStore());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the central --set guard', () => {
  it('--set on a non-set-aware command (restart) hard-errors', async () => {
    await expect(StackRestart.run(['--set', 'journey-fix', ...WS], config)).rejects.toThrow(
      /--set is not supported for this command/,
    );
  });

  it('an unknown set name lists the known sets', async () => {
    await expect(SetProbe.run(['--set', 'nope', ...WS], config)).rejects.toThrow(
      /unknown set 'nope'.*journey-fix, topology/s,
    );
  });

  it('--set X --slot N mismatch is a hard error (the set OWNS its slot)', async () => {
    await expect(SetProbe.run(['--set', 'topology', '--slot', '1', ...WS], config)).rejects.toThrow(
      /set 'topology' is bound to slot 2/,
    );
  });

  it('--set X --slot <matching> is accepted (redundant but consistent)', async () => {
    await expect(SetProbe.run(['--set', 'topology', '--slot', '2', ...WS], config)).resolves.toBeUndefined();
    expect(SetProbe.captured.slot).toBe(2);
  });

  it('a store load failure surfaces as the command error', async () => {
    vi.spyOn(
      BaseCommand.prototype as unknown as { getSetStore: () => SetStore },
      'getSetStore',
    ).mockReturnValue({
      path: () => '/canned/worktree-sets.json',
      load: () => {
        throw new Error('worktree-sets: /canned is not valid JSON: boom');
      },
    });
    await expect(SetProbe.run(['--set', 'topology', ...WS], config)).rejects.toThrow(/not valid JSON: boom/);
  });
});

describe('the parse-level injection (what EVERY downstream consumer sees)', () => {
  it('supplies the set slot + repo paths when the user typed neither', async () => {
    await SetProbe.run(['--set', 'topology', ...WS], config);
    expect(SetProbe.captured.slot).toBe(2);
    expect(SetProbe.captured['saga-dash']).toBe('/set/dash-topology');
    expect(SetProbe.captured.rostering).toBe('/set/rostering-c');
  });

  it('a user-TYPED --<repo> flag beats the set (precedence rung 1)', async () => {
    await SetProbe.run(['--set', 'topology', '--saga-dash', '/typed/dash', ...WS], config);
    expect(SetProbe.captured['saga-dash']).toBe('/typed/dash');
    expect(SetProbe.captured.rostering).toBe('/set/rostering-c');
  });

  it('repos the set does not pin keep their flag/env/default value', async () => {
    await SetProbe.run(['--set', 'journey-fix', ...WS], config);
    // --soa was typed (WS); the set pins only saga-dash.
    expect(SetProbe.captured.soa).toBe(SOA_ROOT);
    expect(SetProbe.captured['saga-dash']).toBe('/set/dash-journey');
  });

  it('no --set = no injection (slot stays 0)', async () => {
    await SetProbe.run([...WS], config);
    expect(SetProbe.captured.slot).toBe(0);
    // NOTE: flags['saga-dash'] is deliberately NOT asserted here — repo flags
    // default from the ambient env at module load, so its value is host-specific.
  });
});
