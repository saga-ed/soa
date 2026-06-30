/**
 * e2e-map unit tests — the M2 e2e-topic PARITY CONTRACT (plan §3.2, §7.2).
 *
 * Asserts the EXACT `{ script, args, env }` each `e2e` subcommand hands the
 * runtime, transcribed from the saga-dash e2e bash arg parsers (check-e2e.sh /
 * connect-session.sh). PURE: no spawn / network / fs.
 */

import { describe, expect, it } from 'vitest';
import { dashE2eScript, e2eConnect, e2eList, e2eRun } from '../e2e-map.js';

const CHECK = dashE2eScript('check-e2e.sh');
const CONNECT = dashE2eScript('connect-session.sh');

describe('dashE2eScript — SAGA_DASH locator', () => {
  it('names the saga-dash e2e dir', () => {
    expect(CHECK).toEqual({ repo: 'SAGA_DASH', relPath: 'apps/web/dash/e2e/check-e2e.sh' });
  });
});

describe('e2eRun() → check-e2e.sh', () => {
  it('bare → no args, no env', () => {
    expect(e2eRun()).toEqual({ script: CHECK, args: [], env: {} });
    expect(e2eRun({})).toEqual({ script: CHECK, args: [], env: {} });
  });

  it('--phase <p> → --phase argv', () => {
    expect(e2eRun({ phase: '2' }).args).toEqual(['--phase', '2']);
    expect(e2eRun({ phase: 'program' }).args).toEqual(['--phase', 'program']);
  });

  it('--headless → --headless argv (headed is the default; no flag)', () => {
    expect(e2eRun({ headless: true }).args).toEqual(['--headless']);
  });

  it('phase + headless + passthrough → argv in canonical order', () => {
    expect(e2eRun({ phase: 'program', headless: true, passthrough: ['--debug', '--timeout=0'] }).args).toEqual([
      '--phase',
      'program',
      '--headless',
      '--debug',
      '--timeout=0',
    ]);
  });

  it('lifecycle knobs become ENV (forwarded by check-e2e.sh to run-stack-e2e.sh)', () => {
    expect(e2eRun({ skipReset: true }).env).toEqual({ SKIP_RESET: '1' });
    expect(e2eRun({ inspect: true }).env).toEqual({ INSPECT: '1' });
    expect(e2eRun({ noInspect: true }).env).toEqual({ INSPECT: '0' });
    expect(e2eRun({ pauseAtEnd: true }).env).toEqual({ PAUSE_AT_END: '1' });
    expect(e2eRun({ inspectUser: 'teacher@saga.org' }).env).toEqual({
      INSPECT_USER: 'teacher@saga.org',
    });
  });

  it('env knobs never leak into argv (and vice versa)', () => {
    const plan = e2eRun({ phase: '5', skipReset: true, pauseAtEnd: true });
    expect(plan.args).toEqual(['--phase', '5']);
    expect(plan.env).toEqual({ SKIP_RESET: '1', PAUSE_AT_END: '1' });
  });
});

describe('e2eList() → check-e2e.sh --help', () => {
  it('lists the phase table via the script help', () => {
    expect(e2eList()).toEqual({ script: CHECK, args: ['--help'], env: {} });
  });
});

describe('e2eConnect() → connect-session.sh', () => {
  it('bare → no args', () => {
    expect(e2eConnect()).toEqual({ script: CONNECT, args: [], env: {} });
  });
  it('--reuse → --reuse; passthrough appended', () => {
    expect(e2eConnect({ reuse: true }).args).toEqual(['--reuse']);
    expect(e2eConnect({ reuse: true, passthrough: ['--debug'] }).args).toEqual(['--reuse', '--debug']);
    expect(e2eConnect({ passthrough: ['--timeout=0'] }).args).toEqual(['--timeout=0']);
  });
});
