/**
 * Native status / verify integration tests (plan §2.4, §7.2 "M2").
 *
 * `stack status` and `stack verify` no longer shell out — they probe a
 * manifest-derived endpoint list through the injectable HealthProber. These
 * tests REPLACE that prober (via `BaseCommand.prototype.getProber`) with a fake
 * that records the probed URLs and returns canned up/down results, so the native
 * gate logic is asserted WITHOUT any real HTTP or a running stack. The `--full`
 * delegation path additionally replaces the Runner (the same seam the M1 wrap
 * tests use) to assert verify.sh is invoked rather than probed.
 *
 * Path resolution is deterministic (--soa <real soa> + --dev <fixed>) so the
 * delegated verify.sh path resolves to the real (READ-ONLY, never run) script.
 */

import { resolve } from 'node:path';
import { Config } from '@oclif/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseCommand } from '../../../base-command.js';
import { computeClosure } from '../../../core/closure.js';
import { manifest } from '../../../core/manifest/index.js';
import type { HealthProber, ProbeResult } from '../../../runtime/health.js';
import type { RunResult, ScriptInvocation } from '../../../runtime/index.js';
import StackStatus from '../status.js';
import StackVerify from '../verify.js';

const PKG_ROOT = process.cwd();
const SOA_ROOT = resolve(PKG_ROOT, '..', '..', '..');
const SYNTH_DIR = resolve(SOA_ROOT, 'tools', 'synthetic-dev');
const VERIFY_SH = resolve(SYNTH_DIR, 'verify.sh');
const DEV_ROOT = '/fixed/dev';
const WS = ['--soa', SOA_ROOT, '--dev', DEV_ROOT];

const CONTENT_URL = 'http://localhost:3009/health';
const DASH_URL = 'http://localhost:8900/';
const SIS_URL = 'http://localhost:3100/health';

let config: Config;
let probed: string[];
let runnerCalls: ScriptInvocation[];
let out: string[];

/** Fake prober: record every probed URL; any URL in `downUrls` answers down. */
function installProber(downUrls: string[] = []): void {
  probed = [];
  const down = new Set(downUrls);
  const fake: HealthProber = {
    async probe(url: string): Promise<ProbeResult> {
      probed.push(url);
      return down.has(url) ? { ok: false } : { ok: true, status: 200 };
    },
  };
  vi.spyOn(
    BaseCommand.prototype as unknown as { getProber: () => HealthProber },
    'getProber',
  ).mockReturnValue(fake);
}

/** Fake Runner for the --full delegation path; records the invocation. */
function installRunner(code = 0): void {
  runnerCalls = [];
  vi.spyOn(
    BaseCommand.prototype as unknown as { getRunner: () => unknown },
    'getRunner',
  ).mockReturnValue({
    async run(spec: ScriptInvocation): Promise<RunResult> {
      runnerCalls.push(spec);
      return { code };
    },
  });
}

beforeEach(async () => {
  config = await Config.load(PKG_ROOT);
  installProber();
  installRunner(0);
  out = [];
  // Capture (and suppress) the commands' emitted lines. oclif's `this.log` does
  // not route through process.stdout.write, so we spy the inherited `log` on the
  // shared BaseCommand prototype — every command instance resolves to it.
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

describe('stack status — native, manifest-derived, read-only', () => {
  it('probes every non-optional service INCLUDING content-api :3009 (the closed gap)', async () => {
    await StackStatus.run([...WS], config);
    expect(probed).toContain(CONTENT_URL);
    expect(probed).toHaveLength(11); // 10 core + rtsm-api; no playback
  });

  it('--only scopes the probes to the dependency closure', async () => {
    await StackStatus.run(['--only', 'connect-web', ...WS], config);
    const expected = computeClosure(manifest, ['connect-web']).services.map(
      (id) => `${manifest.services[id].lane.stack}${manifest.services[id].healthPath}`,
    );
    expect(new Set(probed)).toEqual(new Set(expected));
    expect(probed).toContain('http://localhost:6210/'); // connect-web itself
    expect(probed).toContain(CONTENT_URL); // pulled in via connect-api
  });

  it('NEVER exits non-zero even when services are down (read-only)', async () => {
    installProber([CONTENT_URL, DASH_URL]);
    await expect(StackStatus.run([...WS, '--output-json'], config)).resolves.toBeUndefined();
    const json = JSON.parse(out.join(''));
    expect(json.healthy).toBe(false);
    expect(json.summary).toMatchObject({ total: 11, down: 2 });
  });

  it('porcelain emits one key=value per service plus healthy=', async () => {
    await StackStatus.run([...WS, '--porcelain'], config);
    const text = out.join('\n');
    expect(text).toContain('content-api=up');
    expect(text).toContain('healthy=true');
  });
});

describe('stack verify — native health gate', () => {
  it('PASS (no throw, no exit) when every required service is up', async () => {
    await expect(StackVerify.run([...WS], config)).resolves.toBeUndefined();
    expect(probed).toContain(CONTENT_URL); // gap-closing endpoint is gated
  });

  it('FAIL → exit 1 when a required service is down', async () => {
    installProber([CONTENT_URL]);
    await expect(StackVerify.run([...WS], config)).rejects.toMatchObject({ oclif: { exit: 1 } });
  });

  it('--tolerate <service-id>: a tolerated down service does NOT fail the gate', async () => {
    installProber([CONTENT_URL]);
    await expect(
      StackVerify.run(['--tolerate', 'content-api', ...WS], config),
    ).resolves.toBeUndefined();
  });

  it('--tolerate <repo>: tolerates ALL services of that repo (sis-api via "rostering")', async () => {
    installProber([SIS_URL]);
    await expect(
      StackVerify.run(['--tolerate', 'rostering', ...WS], config),
    ).resolves.toBeUndefined();
  });

  it('a NON-tolerated down service still fails even when another is tolerated', async () => {
    installProber([CONTENT_URL, DASH_URL]);
    await expect(
      StackVerify.run(['--tolerate', 'content-api', ...WS], config),
    ).rejects.toMatchObject({ oclif: { exit: 1 } });
  });

  it('--only scopes the gate to the closure (so a partial stack does not fail on unstarted services)', async () => {
    await StackVerify.run(['--only', 'scheduling-api,sessions-api', ...WS], config);
    const expected = computeClosure(manifest, ['scheduling-api', 'sessions-api']).services.map(
      (id) => `${manifest.services[id].lane.stack}${manifest.services[id].healthPath}`,
    );
    expect(new Set(probed)).toEqual(new Set(expected));
    expect(probed).not.toContain(DASH_URL); // saga-dash not in the closure → not probed
    expect(probed).not.toContain(CONTENT_URL); // content-api not in the closure → not probed
  });

  it('--only: a service OUTSIDE the closure being down does NOT fail the gate', async () => {
    installProber([DASH_URL, CONTENT_URL]); // both outside the scheduling/sessions closure
    await expect(
      StackVerify.run(['--only', 'scheduling-api,sessions-api', ...WS], config),
    ).resolves.toBeUndefined();
  });
});

describe('stack verify --full — delegates the deep checks to verify.sh', () => {
  it('runs verify.sh via the Runner and does NOT probe natively', async () => {
    await StackVerify.run(['--full', ...WS], config);
    expect(probed).toHaveLength(0);
    expect(runnerCalls).toHaveLength(1);
    expect(runnerCalls[0]).toEqual({
      cwd: SYNTH_DIR,
      command: VERIFY_SH,
      args: [],
      env: { DEV: DEV_ROOT, SOA: SOA_ROOT },
      stdio: 'inherit',
    });
  });

  it('--full --health-only adds VERIFY_HEALTH_ONLY=1 to the delegated run', async () => {
    await StackVerify.run(['--full', '--health-only', ...WS], config);
    expect(runnerCalls[0].env).toEqual({
      DEV: DEV_ROOT,
      SOA: SOA_ROOT,
      VERIFY_HEALTH_ONLY: '1',
    });
  });

  it('--full propagates verify.sh non-zero exit code verbatim', async () => {
    installRunner(4);
    await expect(StackVerify.run(['--full', ...WS], config)).rejects.toMatchObject({
      oclif: { exit: 4 },
    });
  });
});
