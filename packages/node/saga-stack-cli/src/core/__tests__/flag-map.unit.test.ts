/**
 * flag-map unit tests — the M1 PARITY CONTRACT golden cases (plan §7.2).
 *
 * These assert the EXACT `{ script, args, env }` each `stack` subcommand hands
 * the runtime — i.e. the precise argv/env a human types at up.sh / verify.sh
 * today. This is THE top-named risk for M1, so the matrix is exhaustive: every
 * subcommand and every meaningful flag combination is pinned here.
 *
 * GROUND TRUTH cross-checked against tools/synthetic-dev/up.sh (the leading-verb
 * `case "${1:-up}"` + the trailing `while`/`case` flag loop, ~lines 1875-1926)
 * and verify.sh's `VERIFY_HEALTH_ONLY` gate (~line 129). The spellings below are
 * byte-for-byte what those scripts parse:
 *   verbs:  up | restart        (down/status are `--down`/`--status` flags)
 *   flags:  --reset  --seed [roster|full]  --pull  --record [crdt|av]
 *           --with-playback  --with-qtf-demo  --tunnel  --login [email]
 *           --only <svc>  --sandbox <name>  --workspace <file.json>
 *   env:    NO_AUTO_PULL=1 (--no-auto-pull)  SKIP_PREP=1 (--skip-prep)
 *           VERIFY_HEALTH_ONLY=1 (verify --health-only)
 *
 * PURE: no docker / pnpm / network / process spawn.
 */

import { describe, expect, it } from 'vitest';
import {
  down,
  FlagNotAvailableError,
  login,
  reset,
  restart,
  seed,
  status,
  up,
  verify,
} from '../flag-map.js';

describe('up() — verb + trailing flags → up.sh argv', () => {
  it('bare up → just the `up` verb, no flags, no env', () => {
    expect(up()).toEqual({ script: 'up.sh', args: ['up'], env: {} });
    // `up({})` is identical to a bare call (default param).
    expect(up({})).toEqual({ script: 'up.sh', args: ['up'], env: {} });
  });

  it('up --reset --seed roster (canonical from-scratch roster lane)', () => {
    expect(up({ reset: true, seed: 'roster' })).toEqual({
      script: 'up.sh',
      args: ['up', '--reset', '--seed', 'roster'],
      env: {},
    });
  });

  it('up --seed full (seed only, no reset)', () => {
    expect(up({ seed: 'full' })).toEqual({
      script: 'up.sh',
      args: ['up', '--seed', 'full'],
      env: {},
    });
  });

  it('up --pull (force ff-only sync of all siblings) stays argv', () => {
    expect(up({ pull: true })).toEqual({
      script: 'up.sh',
      args: ['up', '--pull'],
      env: {},
    });
  });

  it('up --login dev@saga.org (email positional after --login)', () => {
    expect(up({ login: 'dev@saga.org' })).toEqual({
      script: 'up.sh',
      args: ['up', '--login', 'dev@saga.org'],
      env: {},
    });
  });

  it('bare --login (login:true) emits no email positional (up.sh defaults dev@saga.org)', () => {
    expect(up({ login: true })).toEqual({
      script: 'up.sh',
      args: ['up', '--login'],
      env: {},
    });
  });

  it('up --only <svc> is passed THROUGH verbatim (up.sh single-service semantics; comma-list is M4)', () => {
    expect(up({ only: 'scheduling-api' })).toEqual({
      script: 'up.sh',
      args: ['up', '--only', 'scheduling-api'],
      env: {},
    });
  });

  it('up --tunnel takes no argument', () => {
    expect(up({ tunnel: true })).toEqual({
      script: 'up.sh',
      args: ['up', '--tunnel'],
      env: {},
    });
  });

  it('up --with-playback', () => {
    expect(up({ withPlayback: true })).toEqual({
      script: 'up.sh',
      args: ['up', '--with-playback'],
      env: {},
    });
  });

  it('up --with-qtf-demo (mapper passes it through even without --seed; up.sh gates it at seed time)', () => {
    expect(up({ withQtfDemo: true })).toEqual({
      script: 'up.sh',
      args: ['up', '--with-qtf-demo'],
      env: {},
    });
  });

  it('up --workspace f.json', () => {
    expect(up({ workspace: 'f.json' })).toEqual({
      script: 'up.sh',
      args: ['up', '--workspace', 'f.json'],
      env: {},
    });
  });

  it('up --sandbox x --only y → emits --only THEN --sandbox (canonical order)', () => {
    expect(up({ sandbox: 'x', only: 'y' })).toEqual({
      script: 'up.sh',
      args: ['up', '--only', 'y', '--sandbox', 'x'],
      env: {},
    });
  });

  it('--record bare → --record (up.sh defaults crdt); --record av / crdt → mode positional', () => {
    expect(up({ record: true }).args).toEqual(['up', '--record']);
    expect(up({ record: 'av' }).args).toEqual(['up', '--record', 'av']);
    expect(up({ record: 'crdt' }).args).toEqual(['up', '--record', 'crdt']);
  });

  it('restart flag flips the leading verb (up.sh: restart is a verb, NOT a trailing --restart)', () => {
    expect(up({ restart: true })).toEqual({ script: 'up.sh', args: ['restart'], env: {} });
    expect(up({ restart: true, reset: true }).args).toEqual(['restart', '--reset']);
    expect(up({ restart: true, login: 'dev@saga.org' }).args).toEqual([
      'restart',
      '--login',
      'dev@saga.org',
    ]);
  });

  it('--no-auto-pull and --skip-prep are ENV (up.sh reads them from the environment), not argv', () => {
    expect(up({ noAutoPull: true })).toEqual({
      script: 'up.sh',
      args: ['up'],
      env: { NO_AUTO_PULL: '1' },
    });
    expect(up({ skipPrep: true })).toEqual({
      script: 'up.sh',
      args: ['up'],
      env: { SKIP_PREP: '1' },
    });
    expect(up({ noAutoPull: true, skipPrep: true }).env).toEqual({
      NO_AUTO_PULL: '1',
      SKIP_PREP: '1',
    });
  });

  it('full kitchen-sink combo emits every flag in the documented canonical order', () => {
    // Order from up.sh-parity contract: <verb> --reset --seed <p> --pull
    //   --record [m] --with-playback --with-qtf-demo --tunnel --login [e]
    //   --only <s> --sandbox <n> --workspace <f>; env knobs separate.
    expect(
      up({
        reset: true,
        seed: 'full',
        pull: true,
        record: 'av',
        withPlayback: true,
        withQtfDemo: true,
        tunnel: true,
        login: 'empty@saga.org',
        only: 'iam-api',
        sandbox: 'dev-fleet',
        workspace: 'ws.json',
        noAutoPull: true,
        skipPrep: true,
      }),
    ).toEqual({
      script: 'up.sh',
      args: [
        'up',
        '--reset',
        '--seed',
        'full',
        '--pull',
        '--record',
        'av',
        '--with-playback',
        '--with-qtf-demo',
        '--tunnel',
        '--login',
        'empty@saga.org',
        '--only',
        'iam-api',
        '--sandbox',
        'dev-fleet',
        '--workspace',
        'ws.json',
      ],
      env: { NO_AUTO_PULL: '1', SKIP_PREP: '1' },
    });
  });
});

describe('down() / restart() / status() — flag-only / verb invocations', () => {
  it('down → up.sh --down (stops services, leaves the mesh up)', () => {
    expect(down()).toEqual({ script: 'up.sh', args: ['--down'], env: {} });
  });
  it('restart → up.sh restart (leading verb)', () => {
    expect(restart()).toEqual({ script: 'up.sh', args: ['restart'], env: {} });
  });
  it('status → up.sh --status', () => {
    expect(status()).toEqual({ script: 'up.sh', args: ['--status'], env: {} });
  });
});

describe('seed() — up.sh --seed <profile> (+ add-ons)', () => {
  it('profile roster → --seed roster', () => {
    expect(seed({ profile: 'roster' })).toEqual({
      script: 'up.sh',
      args: ['--seed', 'roster'],
      env: {},
    });
  });
  it('profile full → --seed full', () => {
    expect(seed({ profile: 'full' }).args).toEqual(['--seed', 'full']);
  });
  it('empty add-on list behaves like no add-ons', () => {
    expect(seed({ profile: 'roster', addOns: [] }).args).toEqual(['--seed', 'roster']);
  });
  it('playback add-on → --with-playback', () => {
    expect(seed({ profile: 'roster', addOns: ['playback'] }).args).toEqual([
      '--seed',
      'roster',
      '--with-playback',
    ]);
  });
  it('qtf add-on → --with-qtf-demo', () => {
    expect(seed({ profile: 'full', addOns: ['qtf'] }).args).toEqual([
      '--seed',
      'full',
      '--with-qtf-demo',
    ]);
  });
  it('both add-ons → --with-playback --with-qtf-demo (in add-on array order)', () => {
    expect(seed({ profile: 'full', addOns: ['playback', 'qtf'] }).args).toEqual([
      '--seed',
      'full',
      '--with-playback',
      '--with-qtf-demo',
    ]);
  });
});

describe('reset() — up.sh --reset', () => {
  it('bare → --reset', () => {
    expect(reset()).toEqual({ script: 'up.sh', args: ['--reset'], env: {} });
    expect(reset({})).toEqual({ script: 'up.sh', args: ['--reset'], env: {} });
  });
  it('--with-playback also truncates the opt-in playback DBs', () => {
    expect(reset({ withPlayback: true })).toEqual({
      script: 'up.sh',
      args: ['--reset', '--with-playback'],
      env: {},
    });
  });
});

describe('login() — up.sh --login [email]', () => {
  it('bare → --login (up.sh default persona dev@saga.org)', () => {
    expect(login()).toEqual({ script: 'up.sh', args: ['--login'], env: {} });
  });
  it('with email → --login <email>', () => {
    expect(login('teacher@saga.org')).toEqual({
      script: 'up.sh',
      args: ['--login', 'teacher@saga.org'],
      env: {},
    });
  });
});

describe('verify() — verify.sh (no argv; env-gated only)', () => {
  it('default → verify.sh, no args, no env', () => {
    expect(verify()).toEqual({ script: 'verify.sh', args: [], env: {} });
    expect(verify({})).toEqual({ script: 'verify.sh', args: [], env: {} });
  });
  it('--health-only → env VERIFY_HEALTH_ONLY=1, still no argv', () => {
    expect(verify({ healthOnly: true })).toEqual({
      script: 'verify.sh',
      args: [],
      env: { VERIFY_HEALTH_ONLY: '1' },
    });
  });
  it('--tolerate (string or non-empty list) is M1-unsupported → FlagNotAvailableError(M2)', () => {
    expect(() => verify({ tolerate: 'saga-dash' })).toThrow(FlagNotAvailableError);
    expect(() => verify({ tolerate: ['saga-dash', 'rtsm-api'] })).toThrow(/not available until M2/);
  });
  it('empty --tolerate list does not throw (treated as unset)', () => {
    expect(() => verify({ tolerate: [] })).not.toThrow();
    expect(verify({ tolerate: [] })).toEqual({ script: 'verify.sh', args: [], env: {} });
  });
});
