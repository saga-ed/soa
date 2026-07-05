/**
 * `parseWorkspace` unit tests (Phase 2, saga-ed/soa#214) — the PURE port of
 * up.sh's `parse_workspace()`. No jq / filesystem: the command reads + JSON.parses
 * the file, this asserts the mapping to the native launch selection.
 */

import { describe, expect, it } from 'vitest';
import { parseWorkspace } from '../workspace.js';

describe('parseWorkspace — mode mapping → run-set / iam-sandbox / playback', () => {
  it('local-source services become the run-set (declaration order)', () => {
    const sel = parseWorkspace({
      version: '1',
      services: {
        'iam-api': { mode: 'local-source' },
        'sis-api': { mode: 'local-source' },
      },
    });
    expect(sel.runSet).toEqual(['iam-api', 'sis-api']);
    expect(sel.iamSandbox).toBeUndefined();
    expect(sel.playback).toBe(false);
  });

  it('iam-api sandbox → iamSandbox is captured (drives sandbox_env); not in the run-set', () => {
    const sel = parseWorkspace({
      version: '1',
      services: {
        'iam-api': { mode: 'sandbox', sandboxName: 'ws1' },
        'sis-api': { mode: 'local-source' },
      },
    });
    expect(sel.iamSandbox).toBe('ws1');
    expect(sel.runSet).toEqual(['sis-api']);
  });

  it('a non-iam sandbox is recorded but WARNED (dep-repoint is iam-only today)', () => {
    const sel = parseWorkspace({
      version: '1',
      services: {
        'scheduling-api': { mode: 'sandbox', sandboxName: 'sched' },
        'sessions-api': { mode: 'local-source' },
      },
    });
    expect(sel.iamSandbox).toBeUndefined();
    expect(sel.warnings.some((w) => w.includes('scheduling-api'))).toBe(true);
  });

  it('records EVERY sandbox-mode id in sandboxServices (subtracted from the local launch set)', () => {
    const sel = parseWorkspace({
      version: '1',
      services: {
        'iam-api': { mode: 'sandbox', sandboxName: 'ws1' },
        'scheduling-api': { mode: 'sandbox', sandboxName: 'sched' },
        'sessions-api': { mode: 'local-source' },
      },
    });
    // BLOCKER-1: both sandbox-mode services are captured (iam-api AND the non-iam one).
    expect(sel.sandboxServices).toEqual(['iam-api', 'scheduling-api']);
    expect(sel.iamSandbox).toBe('ws1');
    expect(sel.runSet).toEqual(['sessions-api']);
  });

  it('sandboxServices is empty when nothing is sandbox-hosted', () => {
    const sel = parseWorkspace({
      version: '1',
      services: { 'iam-api': { mode: 'local-source' } },
    });
    expect(sel.sandboxServices).toEqual([]);
  });

  it('a playback API in the run-set flips playback on', () => {
    const sel = parseWorkspace({
      version: '1',
      services: { 'insights-api': { mode: 'local-source' } },
    });
    expect(sel.playback).toBe(true);
  });

  it('records per-service dbProfiles for local-source services', () => {
    const sel = parseWorkspace({
      version: '1',
      services: { 'sessions-api': { mode: 'local-source', dbProfile: 'canonical' } },
    });
    expect(sel.dbProfiles).toEqual({ 'sessions-api': 'canonical' });
  });

  it('version != "1" warns but proceeds', () => {
    const sel = parseWorkspace({ version: '2', services: { 'iam-api': { mode: 'local-source' } } });
    expect(sel.warnings.some((w) => w.includes("version '2'"))).toBe(true);
    expect(sel.runSet).toEqual(['iam-api']);
  });

  it('an EMPTY/missing version also warns (up.sh warns for any version != "1")', () => {
    const sel = parseWorkspace({ services: { 'iam-api': { mode: 'local-source' } } });
    expect(sel.warnings.some((w) => w.includes("version ''"))).toBe(true);
    expect(sel.runSet).toEqual(['iam-api']);
  });

  it('dbProfile entries are recorded BUT warned as ignored (native seeds from scratch)', () => {
    const sel = parseWorkspace({
      version: '1',
      services: { 'sessions-api': { mode: 'local-source', dbProfile: 'canonical' } },
    });
    expect(sel.dbProfiles).toEqual({ 'sessions-api': 'canonical' });
    expect(sel.warnings.some((w) => w.includes('dbProfile entries are ignored'))).toBe(true);
  });

  it('all-sandbox (empty run-set) warns nothing-launches', () => {
    const sel = parseWorkspace({
      version: '1',
      services: { 'iam-api': { mode: 'sandbox', sandboxName: 'x' } },
    });
    expect(sel.runSet).toEqual([]);
    expect(sel.warnings.some((w) => w.includes('nothing will launch'))).toBe(true);
  });

  it('rejects local-image (Phase-2 unsupported)', () => {
    expect(() => parseWorkspace({ version: '1', services: { 'iam-api': { mode: 'local-image' } } })).toThrow(
      /local-image/,
    );
  });

  it('rejects an invalid mode', () => {
    expect(() => parseWorkspace({ version: '1', services: { 'iam-api': { mode: 'bogus' } } })).toThrow(
      /invalid mode/,
    );
  });

  it('rejects a sandbox entry with no sandboxName', () => {
    expect(() => parseWorkspace({ version: '1', services: { 'iam-api': { mode: 'sandbox' } } })).toThrow(
      /no sandboxName/,
    );
  });

  it('rejects an empty/missing .services', () => {
    expect(() => parseWorkspace({ version: '1', services: {} })).toThrow(/empty or missing/);
    expect(() => parseWorkspace({ version: '1' })).toThrow(/empty or missing/);
  });
});
