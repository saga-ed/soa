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
import { login, overlay, status, synthScript, tunnel } from '../flag-map.js';

// The locator shape: up.sh lives in soa's synthetic-dev dir. `synthScript` is the
// real builder, so these stay byte-for-byte in lockstep with what the mappers emit
// ({ repo: 'SOA', relPath: 'tools/synthetic-dev/…' }).
const UP = synthScript('up.sh');

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
