/**
 * `stack bundle list` — read-only registry listing (saga-ed/soa#214).
 *
 * The command renders the `core/bundles` registry; these tests run it in-process
 * (capturing `this.log` on the shared BaseCommand prototype, as the status/verify
 * suite does) and assert every bundle surfaces with its services + description,
 * plus the machine-readable `--output-json` shape.
 */

import { Config } from '@oclif/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseCommand } from '../../../../base-command.js';
import { BUNDLES, BUNDLE_NAMES } from '../../../../core/bundles.js';
import BundleList from '../list.js';

const PKG_ROOT = process.cwd();
let config: Config;
let out: string[];

beforeEach(async () => {
  config = await Config.load(PKG_ROOT);
  out = [];
  vi.spyOn(
    BaseCommand.prototype as unknown as { log: (msg?: string) => void },
    'log',
  ).mockImplementation((msg?: string) => {
    out.push(String(msg ?? ''));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('stack bundle list — human table', () => {
  it('renders every bundle with its services and description', async () => {
    await BundleList.run([], config);
    const text = out.join('\n');
    for (const name of BUNDLE_NAMES) {
      expect(text).toContain(name);
      expect(text).toContain(BUNDLES[name].description);
    }
    expect(text).toContain('coach-api, coach-web'); // service list
    expect(text).toContain('seed-only'); // qtf (no services)
    expect(text).toContain('stack up --with <name>'); // header hint
  });
});

describe('stack bundle list --output-json', () => {
  it('emits one object per bundle with name/services/seedAddOn/description', async () => {
    await BundleList.run(['--output-json'], config);
    const json = JSON.parse(out.join(''));
    expect(json).toHaveLength(BUNDLE_NAMES.length);

    const byName = Object.fromEntries(json.map((r: { name: string }) => [r.name, r]));
    expect(byName.coach).toMatchObject({
      name: 'coach',
      services: ['coach-api', 'coach-web'],
      seedAddOn: null,
    });
    expect(byName.playback).toMatchObject({ services: ['transcripts-api', 'insights-api', 'chat-api'], seedAddOn: 'playback' });
    expect(byName.qtf).toMatchObject({ services: [], seedAddOn: 'qtf' });
    expect(byName.dash.description).toBe(BUNDLES.dash.description);
  });
});

describe('stack bundle list --porcelain', () => {
  it('emits one tab-separated line per bundle', async () => {
    await BundleList.run(['--porcelain'], config);
    expect(out).toHaveLength(BUNDLE_NAMES.length);
    const coach = out.find((l) => l.startsWith('coach\t'));
    expect(coach).toBe(`coach\tcoach-api,coach-web\t\t${BUNDLES.coach.description}`);
  });
});
