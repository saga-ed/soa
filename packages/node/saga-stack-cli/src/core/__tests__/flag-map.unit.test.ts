/**
 * flag-map unit tests — the PARITY CONTRACT golden cases for the remaining VENDORED
 * bash wrappers (overlay→refresh-suite.sh, tunnel→tunnel.sh).
 *
 * These assert the EXACT `{ args, env }` each `stack` subcommand hands the runtime —
 * the precise argv/env a human types at the underlying script. The `up`/`status`/
 * `login` up.sh mappers (and the `synthScript('up.sh')` locator) were REMOVED in the
 * Phase-2 FINISH decoupling — those commands are fully native. Only the vendored
 * overlay/tunnel wrappers remain here.
 *
 * GROUND TRUTH cross-checked against the vendored refresh-suite.sh (arg loop) +
 * tunnel.sh (`case "${1:-up}"` dispatch). PURE: no docker / pnpm / network / process spawn.
 */

import { describe, expect, it } from 'vitest';
import { overlay, tunnel } from '../flag-map.js';

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
