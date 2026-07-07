/**
 * Post-down orphan-audit seam (saga-ed/soa#249) — real-scanner logic with an
 * injected capture fake: the `ss -lptnH` parse (pid/command extraction, port
 * filtering, v4/v6 duplicate collapse), the per-port `lsof -Fpc` fallback when
 * `ss` is unavailable, and the degrade-open contract (any capture failure ⇒
 * "no survivors", never a throw). NO real exec is touched.
 */

import { describe, expect, it } from 'vitest';
import { SS_CANDIDATES, makeRealOrphanScanner, parseSsRow } from '../orphan-audit.js';

const SS_OUT = [
  // survivor on 4006 with visible owner (own process — the launcher's orphan case).
  'LISTEN 0 511          *:4006       *:*    users:(("node",pid=873122,fd=27))',
  // same socket's v6 row WITHOUT the process column — must collapse, keeping the pid row.
  'LISTEN 0 511       [::]:4006      [::]:*',
  // survivor on 4010, owner not visible (foreign process).
  'LISTEN 0 128    0.0.0.0:4010    0.0.0.0:*',
  // listener OUTSIDE the audited band — must be filtered out.
  'LISTEN 0 4096 127.0.0.1:5432  0.0.0.0:*    users:(("docker-proxy",pid=999,fd=4))',
].join('\n');

describe('parseSsRow', () => {
  it('extracts port + pid + command from a full row', () => {
    expect(parseSsRow('LISTEN 0 511 *:4006 *:* users:(("node",pid=873122,fd=27))')).toEqual({
      port: 4006,
      pid: 873122,
      command: 'node',
    });
  });

  it('handles an IPv6 local address and a missing process column', () => {
    expect(parseSsRow('LISTEN 0 511 [::]:4010 [::]:*')).toEqual({ port: 4010 });
  });

  it('returns null for a malformed or non-LISTEN row (the shadowed-ss junk guard)', () => {
    expect(parseSsRow('')).toBeNull();
    expect(parseSsRow('LISTEN 0 511')).toBeNull();
    // Bare `ss` on a dev machine can BE the saga-stack CLI (pnpm bin shadowing
    // iproute2) — its usage/error text must never parse as a listener.
    expect(parseSsRow('› Error: command -lptnH not found')).toBeNull();
    expect(parseSsRow('ESTAB 0 0 127.0.0.1:4006 127.0.0.1:51234')).toBeNull();
  });
});

describe('makeRealOrphanScanner.scan — ss path', () => {
  it('reports only the audited ports, with pid/command when visible, sorted by port', async () => {
    const calls: Array<[string, string[]]> = [];
    const scanner = makeRealOrphanScanner(async (cmd, args) => {
      calls.push([cmd, args]);
      return cmd === SS_CANDIDATES[0] ? SS_OUT : '';
    });

    const survivors = await scanner.scan([4010, 4006, 4008]);

    // ONE ss enumeration off the first usable candidate — never a per-port exec.
    expect(calls).toEqual([[SS_CANDIDATES[0], ['-lptnH']]]);
    expect(survivors).toEqual([
      { port: 4006, pid: 873122, command: 'node' }, // pid row won over the bare v6 row
      { port: 4010 }, // holder not visible — still reported
      // 4008 clean — absent; 5432 outside the band — filtered.
    ]);
  });

  it('walks the candidate ladder past absent binaries AND a shadowed bare `ss` (junk output)', async () => {
    // /usr/sbin/ss + /usr/bin/ss absent (''); bare `ss` IS the saga-stack CLI
    // (pnpm bin shadowing iproute2) emitting usage junk — no LISTEN row parses,
    // so the scanner must fall through to lsof rather than report "clean".
    const calls: string[] = [];
    const scanner = makeRealOrphanScanner(async (cmd, args) => {
      calls.push(cmd);
      if (cmd === 'ss') return '› Error: command -lptnH not found\nUSAGE\n  $ ss [COMMAND]\n';
      if (cmd === 'lsof') return args.includes('-iTCP:4006') ? 'p873122\ncnode\n' : '';
      return '';
    });

    const survivors = await scanner.scan([4006]);

    expect(calls).toEqual([...SS_CANDIDATES, 'lsof']);
    expect(survivors).toEqual([{ port: 4006, pid: 873122, command: 'node' }]);
  });

  it('returns [] without exec for an empty port band', async () => {
    let called = false;
    const scanner = makeRealOrphanScanner(async () => {
      called = true;
      return SS_OUT;
    });
    expect(await scanner.scan([])).toEqual([]);
    expect(called).toBe(false);
  });
});

describe('makeRealOrphanScanner.scan — lsof fallback + degrade-open', () => {
  it('falls back to per-port lsof -Fpc when ss yields nothing', async () => {
    const lsofCalls: string[][] = [];
    const scanner = makeRealOrphanScanner(async (cmd, args) => {
      if (SS_CANDIDATES.includes(cmd)) return ''; // every ss candidate missing/failed
      lsofCalls.push(args);
      // survivor only on 4006; terse -Fpc output: p<pid> then c<command>.
      return args.includes('-iTCP:4006') ? 'p873122\ncnode\n' : '';
    });

    const survivors = await scanner.scan([4010, 4006]);

    expect(lsofCalls).toEqual([
      ['-nP', '-iTCP:4006', '-sTCP:LISTEN', '-Fpc'],
      ['-nP', '-iTCP:4010', '-sTCP:LISTEN', '-Fpc'],
    ]);
    expect(survivors).toEqual([{ port: 4006, pid: 873122, command: 'node' }]);
  });

  it('degrades open (no survivors) when both ss and lsof are unavailable', async () => {
    const scanner = makeRealOrphanScanner(async () => '');
    expect(await scanner.scan([4006, 4010])).toEqual([]);
  });
});
