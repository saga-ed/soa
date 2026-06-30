/**
 * sync-dash-local-defaults prelaunch hook (plan §7.2 M4; up.sh
 * sync_dash_local_defaults). The fs is injected, so this asserts the mode-for-
 * mode behaviour with NO real filesystem: no-static no-op, non-tunnel remove /
 * absent no-op, and the tunnel-mode config contents.
 */

import { describe, expect, it } from 'vitest';
import {
  DASH_TUNNEL_LABELS,
  dashLocalConfigPath,
  syncDashLocalDefaults,
  tunnelConfigContents,
} from '../dash-defaults.js';
import type { DashFs } from '../dash-defaults.js';

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
