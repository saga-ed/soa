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
import { login, overlay, status, synthScript, tunnel, up } from '../flag-map.js';

// The locator shape: up.sh lives in soa's synthetic-dev dir. `synthScript` is the
// real builder, so these stay byte-for-byte in lockstep with what the mappers emit
// ({ repo: 'SOA', relPath: 'tools/synthetic-dev/…' }).
const UP = synthScript('up.sh');

describe('up() — verb + trailing flags → up.sh argv', () => {
  it('bare up → just the `up` verb, no flags, no env', () => {
    expect(up()).toEqual({ script: UP, args: ['up'], env: {} });
    // `up({})` is identical to a bare call (default param).
    expect(up({})).toEqual({ script: UP, args: ['up'], env: {} });
  });

  it('up --reset --seed roster (canonical from-scratch roster lane)', () => {
    expect(up({ reset: true, seed: 'roster' })).toEqual({
      script: UP,
      args: ['up', '--reset', '--seed', 'roster'],
      env: {},
    });
  });

  it('up --seed full (seed only, no reset)', () => {
    expect(up({ seed: 'full' })).toEqual({
      script: UP,
      args: ['up', '--seed', 'full'],
      env: {},
    });
  });

  it('up --pull (force ff-only sync of all siblings) stays argv', () => {
    expect(up({ pull: true })).toEqual({
      script: UP,
      args: ['up', '--pull'],
      env: {},
    });
  });

  it('up --login dev@saga.org (email positional after --login)', () => {
    expect(up({ login: 'dev@saga.org' })).toEqual({
      script: UP,
      args: ['up', '--login', 'dev@saga.org'],
      env: {},
    });
  });

  it('bare --login (login:true) emits no email positional (up.sh defaults dev@saga.org)', () => {
    expect(up({ login: true })).toEqual({
      script: UP,
      args: ['up', '--login'],
      env: {},
    });
  });

  it('up --only <svc> is passed THROUGH verbatim (up.sh single-service semantics; comma-list is M4)', () => {
    expect(up({ only: 'scheduling-api' })).toEqual({
      script: UP,
      args: ['up', '--only', 'scheduling-api'],
      env: {},
    });
  });

  it('up --tunnel takes no argument', () => {
    expect(up({ tunnel: true })).toEqual({
      script: UP,
      args: ['up', '--tunnel'],
      env: {},
    });
  });

  it('up --with-playback', () => {
    expect(up({ withPlayback: true })).toEqual({
      script: UP,
      args: ['up', '--with-playback'],
      env: {},
    });
  });

  it('up --with-qtf-demo (mapper passes it through even without --seed; up.sh gates it at seed time)', () => {
    expect(up({ withQtfDemo: true })).toEqual({
      script: UP,
      args: ['up', '--with-qtf-demo'],
      env: {},
    });
  });

  it('up --workspace f.json', () => {
    expect(up({ workspace: 'f.json' })).toEqual({
      script: UP,
      args: ['up', '--workspace', 'f.json'],
      env: {},
    });
  });

  it('up --sandbox x --only y → emits --only THEN --sandbox (canonical order)', () => {
    expect(up({ sandbox: 'x', only: 'y' })).toEqual({
      script: UP,
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
    expect(up({ restart: true })).toEqual({ script: UP, args: ['restart'], env: {} });
    expect(up({ restart: true, reset: true }).args).toEqual(['restart', '--reset']);
    expect(up({ restart: true, login: 'dev@saga.org' }).args).toEqual([
      'restart',
      '--login',
      'dev@saga.org',
    ]);
  });

  it('--no-auto-pull and --skip-prep are ENV (up.sh reads them from the environment), not argv', () => {
    expect(up({ noAutoPull: true })).toEqual({
      script: UP,
      args: ['up'],
      env: { NO_AUTO_PULL: '1' },
    });
    expect(up({ skipPrep: true })).toEqual({
      script: UP,
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
      script: UP,
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

describe('status() — flag-only invocation', () => {
  it('status → up.sh --status', () => {
    expect(status()).toEqual({ script: UP, args: ['--status'], env: {} });
  });
});

describe('login() — up.sh --login [email]', () => {
  it('bare → --login (up.sh default persona dev@saga.org)', () => {
    expect(login()).toEqual({ script: UP, args: ['--login'], env: {} });
  });
  it('with email → --login <email>', () => {
    expect(login('teacher@saga.org')).toEqual({
      script: UP,
      args: ['--login', 'teacher@saga.org'],
      env: {},
    });
  });
});

describe('overlay() — refresh-suite.sh verbs', () => {
  it('apply (bare) → no args (file-driven integration-suite.local.tsv)', () => {
    expect(overlay('apply')).toEqual({ args: [], env: {} });
    expect(overlay('apply', {})).toEqual({ args: [], env: {} });
  });
  it('apply --prs <set> <repo…> → ad-hoc overlay argv', () => {
    expect(overlay('apply', { prs: '165', repos: ['saga-dash'] })).toEqual({ args: ['--prs', '165', 'saga-dash'],
      env: {},
    });
    expect(overlay('apply', { prs: '410,432', repos: ['rostering', 'program-hub'] }).args).toEqual([
      '--prs',
      '410,432',
      'rostering',
      'program-hub',
    ]);
  });
  it('list → --list (ignores repos/env)', () => {
    expect(overlay('list')).toEqual({ args: ['--list'], env: {} });
  });
  it('reset → --reset; reset <repo…> → --reset <repo…>', () => {
    expect(overlay('reset')).toEqual({ args: ['--reset'], env: {} });
    expect(overlay('reset', { repos: ['rostering'] }).args).toEqual(['--reset', 'rostering']);
  });
  it('compose-rest <name> → --compose-rest <name>', () => {
    expect(overlay('compose-rest', { sandbox: 'dev' })).toEqual({ args: ['--compose-rest', 'dev'],
      env: {},
    });
  });
  it('BASE and SANDBOX_* knobs surface as ENV, not argv', () => {
    expect(overlay('apply', { base: 'develop' }).env).toEqual({ BASE: 'develop' });
    expect(
      overlay('compose-rest', {
        sandbox: 'dev',
        ttlHours: '6',
        seedProfile: 'canonical',
        bypassHeader: 'X-Foo: bar',
      }),
    ).toEqual({ args: ['--compose-rest', 'dev'],
      env: {
        SANDBOX_TTL_HOURS: '6',
        SANDBOX_SEED_PROFILE: 'canonical',
        SANDBOX_BYPASS_HEADER: 'X-Foo: bar',
      },
    });
  });
});

describe('tunnel() — tunnel.sh verb dispatch', () => {
  it('each verb → tunnel.sh <verb> (moniker is the VERB, never a flag value)', () => {
    for (const v of ['up', 'down', 'status', 'moniker', 'urls', 'aws-profile'] as const) {
      expect(tunnel(v)).toEqual({ args: [v], env: {} });
    }
  });
  it('--vms-base surfaces as env VMS_BASE', () => {
    expect(tunnel('up', { vmsBase: 'vms.example.com' })).toEqual({ args: ['up'],
      env: { VMS_BASE: 'vms.example.com' },
    });
  });
});
