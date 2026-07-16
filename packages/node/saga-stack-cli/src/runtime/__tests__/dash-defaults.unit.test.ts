/**
 * sync-dash-local-defaults prelaunch hook (plan §7.2 M4; up.sh
 * sync_dash_local_defaults). The fs is injected, so this asserts the mode-for-
 * mode behaviour with NO real filesystem: no-static no-op, non-tunnel remove /
 * absent no-op, and the tunnel-mode config contents.
 */

import { describe, expect, it } from 'vitest';
import {
  DASH_CONFIG_ENV_VAR,
  DASH_LOCAL_SERVICES,
  DASH_TUNNEL_LABELS,
  buildDashLocalDefaultsJson,
  dashLocalConfigPath,
  stackSlotConfigContents,
  syncDashLocalDefaults,
  tunnelConfigContents,
} from '../dash-defaults.js';
import type { DashFs } from '../dash-defaults.js';
import { getService } from '../../core/manifest/index.js';
import type { ServiceId } from '../../core/manifest/index.js';

const DASH = '/repo/saga-dash';
const CFG = dashLocalConfigPath(DASH);

/** A fake fs with controllable existence + recorded mutations. */
function fakeFs(opts: { hasStatic?: boolean; hasConfig?: boolean } = {}): {
  fs: DashFs;
  removed: string[];
  written: Array<{ path: string; contents: string }>;
} {
  const removed: string[] = [];
  const written: Array<{ path: string; contents: string }> = [];
  const fs: DashFs = {
    existsDir: () => opts.hasStatic ?? true,
    existsFile: () => opts.hasConfig ?? false,
    remove: (path) => removed.push(path),
    write: (path, contents) => written.push({ path, contents }),
  };
  return { fs, removed, written };
}

describe('syncDashLocalDefaults', () => {
  it('no-ops when the dash static dir is absent (dash not checked out here)', () => {
    const { fs, removed, written } = fakeFs({ hasStatic: false });
    const res = syncDashLocalDefaults({ sagaDashRoot: DASH }, fs);
    expect(res.action).toBe('noop-no-static');
    expect(removed).toEqual([]);
    expect(written).toEqual([]);
  });

  it('non-tunnel: removes a stale config.local.json (localhost defaults)', () => {
    const { fs, removed } = fakeFs({ hasConfig: true });
    const res = syncDashLocalDefaults({ sagaDashRoot: DASH, tunnel: false }, fs);
    expect(res).toEqual({ action: 'removed', path: CFG });
    expect(removed).toEqual([CFG]);
  });

  it('non-tunnel: clean no-op when the config is already absent (idempotent)', () => {
    const { fs, removed } = fakeFs({ hasConfig: false });
    const res = syncDashLocalDefaults({ sagaDashRoot: DASH }, fs);
    expect(res).toEqual({ action: 'noop-absent', path: CFG });
    expect(removed).toEqual([]);
  });

  it('tunnel: writes the <svc>→https://<label>.<domain> map', () => {
    const { fs, written } = fakeFs();
    const res = syncDashLocalDefaults(
      { sagaDashRoot: DASH, tunnel: true, tunnelDomain: 'abc.vms.wootdev.com' },
      fs,
    );
    expect(res).toEqual({ action: 'wrote', path: CFG });
    expect(written).toHaveLength(1);
    const parsed = JSON.parse(written[0].contents);
    expect(parsed.localDefaults.iam).toEqual({ type: 'url', url: 'https://iam.abc.vms.wootdev.com' });
    expect(parsed.localDefaults['program-hub']).toEqual({
      type: 'url',
      url: 'https://programs.abc.vms.wootdev.com',
    });
    // ads-adm MUST route to its tunnel host (the dash Overview page dials it for
    // real) — not fall back to config.json's localhost:5005 (a mixed-content
    // block from the HTTPS tunnel page).
    expect(parsed.localDefaults['ads-adm']).toEqual({
      type: 'url',
      url: 'https://ads-adm.abc.vms.wootdev.com',
    });
    // transcripts-api/ledger-api are NOT forwarded by the tunnel, so they must
    // stay out of the tunnel map (a label would point at a dead host).
    expect(parsed.localDefaults['transcripts-api']).toBeUndefined();
    expect(parsed.localDefaults['ledger-api']).toBeUndefined();
    // every label key present, trailing newline preserved.
    expect(Object.keys(parsed.localDefaults).sort()).toEqual(Object.keys(DASH_TUNNEL_LABELS).sort());
    expect(written[0].contents.endsWith('\n')).toBe(true);
  });

  it('tunnel without a domain: skips the write rather than emit a broken url', () => {
    const { fs, written } = fakeFs();
    const res = syncDashLocalDefaults({ sagaDashRoot: DASH, tunnel: true }, fs);
    expect(res.action).toBe('noop-absent');
    expect(written).toEqual([]);
  });

  it('tunnelConfigContents is 2-space-indented JSON with a trailing newline', () => {
    const out = tunnelConfigContents('d.example');
    expect(out).toContain('\n  "localDefaults"');
    expect(out.endsWith('}\n')).toBe(true);
  });

  it('defaults the real fs when none is injected (does not throw on a missing dir)', () => {
    // /no/such/dash has no static dir → noop-no-static via the real fs.
    const res = syncDashLocalDefaults({ sagaDashRoot: '/no/such/dash-xyz' });
    expect(res.action).toBe('noop-no-static');
  });
});

describe('syncDashLocalDefaults — M7 stack-lane slot config', () => {
  /** slot-N port map for the dash-backing services. */
  const slotPorts = (offset: number): Partial<Record<ServiceId, number>> => ({
    'iam-api': 3010 + offset,
    'programs-api': 3006 + offset,
    'scheduling-api': 3008 + offset,
    'sessions-api': 3007 + offset,
    'sis-api': 3100 + offset,
    'content-api': 3009 + offset,
    'connect-api': 6106 + offset,
    'ads-adm-api': 5005 + offset,
    'transcripts-api': 6302 + offset,
  });

  it('slot 0 still REMOVES config.local.json (byte-identical) even with stackPorts present', () => {
    const { fs, removed, written } = fakeFs({ hasConfig: true });
    const res = syncDashLocalDefaults(
      { sagaDashRoot: DASH, slot: 0, stackPorts: slotPorts(0) },
      fs,
    );
    expect(res).toEqual({ action: 'removed', path: CFG });
    expect(removed).toEqual([CFG]);
    expect(written).toEqual([]);
  });

  it('slot > 0 (stack lane) WRITES config.local.json with offset localhost ports', () => {
    const { fs, written, removed } = fakeFs({ hasConfig: true });
    const res = syncDashLocalDefaults(
      { sagaDashRoot: DASH, slot: 1, stackPorts: slotPorts(1000) },
      fs,
    );
    expect(res).toEqual({ action: 'wrote-stack-slot', path: CFG });
    expect(removed).toEqual([]); // it writes, does not remove
    expect(written).toHaveLength(1);
    const parsed = JSON.parse(written[0].contents);
    // iam offset: 3010 + 1000; program-hub + enrollment-api both back programs-api (4006).
    expect(parsed.localDefaults.iam).toEqual({ type: 'url', url: 'http://localhost:4010' });
    expect(parsed.localDefaults['program-hub']).toEqual({ type: 'url', url: 'http://localhost:4006' });
    expect(parsed.localDefaults['enrollment-api']).toEqual({ type: 'url', url: 'http://localhost:4006' });
    expect(parsed.localDefaults.connect).toEqual({ type: 'url', url: 'http://localhost:7106' });
    // ads-adm + transcripts-api MUST offset too (the browser dials them for real —
    // the split-brain BLOCKER). Base config.json ports (5005 / 6302 = slot 0) must
    // NOT leak through: slot 1 ⇒ 6005 / 7302.
    expect(parsed.localDefaults['ads-adm']).toEqual({ type: 'url', url: 'http://localhost:6005' });
    expect(parsed.localDefaults['ads-adm'].url).not.toContain(':5005'); // NOT slot 0's ads-adm
    expect(parsed.localDefaults['transcripts-api']).toEqual({
      type: 'url',
      url: 'http://localhost:7302',
    });
    // same key set as the tunnel writer.
    expect(Object.keys(parsed.localDefaults).sort()).toEqual(Object.keys(DASH_LOCAL_SERVICES).sort());
    expect(written[0].contents.endsWith('\n')).toBe(true);
  });

  it('stackSlotConfigContents omits a dash key whose backing service has no resolved port', () => {
    const parsed = JSON.parse(stackSlotConfigContents({ 'iam-api': 4010 }));
    expect(parsed.localDefaults.iam).toEqual({ type: 'url', url: 'http://localhost:4010' });
    expect(parsed.localDefaults.connect).toBeUndefined(); // connect-api port absent → dropped
  });
});

describe('buildDashLocalDefaultsJson — soa#328 per-instance env JSON', () => {
  const PORTS: Partial<Record<ServiceId, number>> = {
    'iam-api': 4010,
    'programs-api': 4006,
    'ads-adm-api': 6005,
  };

  it('the env var name is the locked cross-repo contract', () => {
    // saga-dash's dev-server middleware reads process.env.DASH_CONFIG_LOCAL_JSON —
    // renaming this breaks the cross-repo contract (soa#328).
    expect(DASH_CONFIG_ENV_VAR).toBe('DASH_CONFIG_LOCAL_JSON');
  });

  it("the env var is a saga-dash adoptEnv guard key (manifest ties to the constant)", () => {
    // The env now SHADOWS the static file in a new-enough dash, so an already-up
    // dash carrying a different mode's stamp must be REFUSED, not adopted — else
    // `up --tunnel` → plain `up` leaves a dash serving dead tunnel hosts from its
    // frozen env after the file hook removed config.local.json (the file-only
    // self-heal is gone). services.ts declares the key as a string literal (core
    // can't import runtime); this pins the two together.
    expect(getService('saga-dash').adoptEnv).toContain(DASH_CONFIG_ENV_VAR);
  });

  it('tunnel mode: returns the EXACT string the tunnel file writer emits', () => {
    expect(buildDashLocalDefaultsJson({ tunnel: true, tunnelDomain: 'abc.vms.wootdev.com' })).toBe(
      tunnelConfigContents('abc.vms.wootdev.com'),
    );
  });

  it('tunnel without a domain: null (never an https://<label>.undefined config)', () => {
    expect(buildDashLocalDefaultsJson({ tunnel: true })).toBeNull();
  });

  it('non-tunnel slot > 0: returns the EXACT string the slot file writer emits', () => {
    expect(buildDashLocalDefaultsJson({ slot: 1, stackPorts: PORTS })).toBe(
      stackSlotConfigContents(PORTS),
    );
  });

  it('non-tunnel slot 0: null even with stackPorts present (nothing to inject)', () => {
    expect(buildDashLocalDefaultsJson({ slot: 0, stackPorts: PORTS })).toBeNull();
    expect(buildDashLocalDefaultsJson({ stackPorts: PORTS })).toBeNull();
  });

  it('non-tunnel slot > 0 WITHOUT stackPorts: null (no ports to point at)', () => {
    expect(buildDashLocalDefaultsJson({ slot: 1 })).toBeNull();
  });

  it('output satisfies the reader contract: JSON.parse yields a localDefaults url map', () => {
    // The dash middleware serves the string VERBATIM after a JSON.parse gate.
    const out = buildDashLocalDefaultsJson({ slot: 1, stackPorts: PORTS });
    const parsed = JSON.parse(out ?? 'null');
    expect(parsed.localDefaults.iam).toEqual({ type: 'url', url: 'http://localhost:4010' });
    expect(parsed.localDefaults['ads-adm']).toEqual({ type: 'url', url: 'http://localhost:6005' });
  });
});
