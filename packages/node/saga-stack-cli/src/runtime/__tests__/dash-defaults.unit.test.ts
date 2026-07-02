/**
 * sync-dash-local-defaults prelaunch hook (plan §7.2 M4; up.sh
 * sync_dash_local_defaults). The fs is injected, so this asserts the mode-for-
 * mode behaviour with NO real filesystem: no-static no-op, non-tunnel remove /
 * absent no-op, and the tunnel-mode config contents.
 */

import { describe, expect, it } from 'vitest';
import {
  DASH_LOCAL_SERVICES,
  DASH_TUNNEL_LABELS,
  dashLocalConfigPath,
  stackSlotConfigContents,
  syncDashLocalDefaults,
  tunnelConfigContents,
} from '../dash-defaults.js';
import type { DashFs } from '../dash-defaults.js';
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
