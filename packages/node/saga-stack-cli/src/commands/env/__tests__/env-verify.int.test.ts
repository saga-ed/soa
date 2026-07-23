/**
 * `ss env verify` tests (soa#355) — the deployed-env health gate.
 *
 * The load-bearing case is the SHARED-ALB TRAP: `*.wootdev.com` is wildcard DNS
 * onto an ALB whose default action answers **200 with body `dev-account-alb`**
 * for unmatched hosts, so a status-code-only gate would call a non-existent
 * service healthy. These tests pin that a 200 + ALB body is a FAILURE, plus the
 * probe URL map, no-public-route handling, --tolerate, --org skeleton assertion,
 * and the exit codes.
 */

import { Config } from '@oclif/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseCommand } from '../../../base-command.js';
import { buildEnvHealthProbes, classifyEcsState, classifyProbeBody } from '../../../core/env/index.js';
import type { EnvPsql, HealthProber, ProbeResult } from '../../../runtime/index.js';
import EnvVerify from '../verify.js';

const PKG_ROOT = process.cwd();
const ORG_ID = '52a00136-285b-522c-bc70-0887cf46463a';
const ADMIN = '506605c6-f2c5-5785-9837-7970e7a2594c';
const MEMB = '80089e21-6aea-520e-8940-d292e0e12f92';

const okApi = (name: string): ProbeResult => ({ ok: true, status: 200, body: `{"status":"ok","service":"${name}"}` });
const albDefault: ProbeResult = { ok: true, status: 200, body: 'dev-account-alb' };
const okFrontend: ProbeResult = { ok: true, status: 200, body: '<!doctype html><html><head></head></html>' };

let config: Config;
let out: string[];
let probed: string[];

const text = (): string => out.join('\n');

/** Every service healthy unless `overrides` says otherwise (keyed by URL substring). */
function installProber(overrides: Record<string, ProbeResult> = {}): void {
  const fake: HealthProber = {
    async probe(url): Promise<ProbeResult> {
      probed.push(url);
      for (const [needle, result] of Object.entries(overrides)) {
        if (url.includes(needle)) return result;
      }
      return url.endsWith('/health') ? okApi('Some API') : okFrontend;
    },
  };
  vi.spyOn(BaseCommand.prototype as unknown as { getProber: () => HealthProber }, 'getProber').mockReturnValue(fake);
}

function installEnvPsql(rows: { org?: string; admin?: string; memb?: boolean } = {}): void {
  const fake: EnvPsql = {
    async query(_conn, sql): Promise<string[][]> {
      if (sql.includes('FROM groups')) return [[rows.org ?? 'Empty Org']];
      if (sql.includes('FROM users')) return [[rows.admin ?? 'empty']];
      if (sql.includes('FROM group_memberships')) return (rows.memb ?? true) ? [[MEMB]] : [];
      throw new Error(`unexpected sql: ${sql}`);
    },
  };
  vi.spyOn(BaseCommand.prototype as unknown as { getEnvPsql: () => EnvPsql }, 'getEnvPsql').mockReturnValue(fake);
}

beforeEach(async () => {
  config = await Config.load(PKG_ROOT);
  out = [];
  probed = [];
  vi.spyOn(BaseCommand.prototype as unknown as { log: (m?: string) => void }, 'log').mockImplementation((m?: string) => {
    out.push(String(m ?? ''));
  });
  installProber();
  installEnvPsql();
});

afterEach(() => vi.restoreAllMocks());

describe('probe planning (pure)', () => {
  it('maps each service to its VERIFIED deployed host, not the manifest tunnelSlug', () => {
    const byId = Object.fromEntries(buildEnvHealthProbes('wootdev.com', 'dev').map((p) => [p.id, p.url]));
    // Short slugs…
    expect(byId['iam-api']).toBe('https://iam.wootdev.com/health');
    expect(byId['sis-api']).toBe('https://sis.wootdev.com/health');
    // …full service ids (programs.wootdev.com is the ALB default, not the API).
    expect(byId['programs-api']).toBe('https://programs-api.wootdev.com/health');
    expect(byId['sessions-api']).toBe('https://sessions-api.wootdev.com/health');
    // coach.<domain> is the WEB frontend; the API is coach-api.
    expect(byId['coach-api']).toBe('https://coach-api.wootdev.com/health');
    expect(byId['coach-web']).toBe('https://coach.wootdev.com/');
    expect(byId['saga-dash']).toBe('https://dash.wootdev.com/');
    // connect-api answers on connectv3-api (from the ALB host-header rules).
    expect(byId['connect-api']).toBe('https://connectv3-api.wootdev.com/connectv3/v1/health');
    // rtsm runs on its own geo cluster; the bare `core` alias fails TLS, core-a answers.
    expect(byId['rtsm-api']).toBe('https://chi-1.rtsm.wootdev.com/health');
    // fleek is its own Caddy recording fleet.
    expect(byId['fleek']).toBe('https://chi-1.fleek.wootdev.com/health');
    expect(byId['fleek-recorder']).toBe('https://recorder-chi-1.fleek.wootdev.com/v1/health');
    // connect-web is on Amplify with NO custom domain — a per-env branch URL.
    expect(byId['connect-web']).toBe('https://dev.d2ezd4i8b4uexc.amplifyapp.com/');
  });

  it('re-targets per-env services, but pins SHARED fleets to their real host', () => {
    const byId = Object.fromEntries(buildEnvHealthProbes('saga-training.org', 'training').map((p) => [p.id, p.url]));
    expect(byId['iam-api']).toBe('https://iam.saga-training.org/health');
    // rtsm/fleek are ONE fleet serving both envs — training's own connectv3-api
    // task def points at .wootdev.com — so they must NOT be domain-templated.
    expect(byId['rtsm-api']).toBe('https://chi-1.rtsm.wootdev.com/health');
    expect(byId['fleek']).toBe('https://chi-1.fleek.wootdev.com/health');
    expect(byId['fleek-recorder']).toBe('https://recorder-chi-1.fleek.wootdev.com/v1/health');
    // connect-web resolves to the TRAINING Amplify branch, not a wootdev host.
    expect(byId['connect-web']).toBe('https://training.d2ezd4i8b4uexc.amplifyapp.com/');
  });
});

describe('body classification — the shared-ALB trap', () => {
  it('treats the ALB default body as NOT healthy even though it is a 200', () => {
    expect(classifyProbeBody('dev-account-alb', 'api')).toBe('alb-default');
    expect(classifyProbeBody('dev-account-alb', 'frontend')).toBe('alb-default');
  });

  it('accepts every status word the live fleet actually uses, and real frontend HTML', () => {
    // Surveyed live on dev: services disagree on the word — all mean healthy.
    expect(classifyProbeBody('{"status":"ok","service":"IAM API"}', 'api')).toBe('healthy');
    expect(classifyProbeBody('{"status":"running","service":"SIS API","uptime":1,"sisDb":"connected"}', 'api')).toBe('healthy');
    expect(classifyProbeBody('{"status":"running","service":"ADS/ADM API","uptime":1}', 'api')).toBe('healthy');
    expect(classifyProbeBody('{"status":"healthy","service":"Coach API","uptime":1}', 'api')).toBe('healthy');
    // connect-api carries NO `service` key — a healthy status is the signal.
    expect(classifyProbeBody('{"status":"ok","mongo":"ok"}', 'api')).toBe('healthy');
    expect(classifyProbeBody('<!doctype html><html></html>', 'frontend')).toBe('healthy');
  });

  it("'plain' hosts (fleek's own Caddy fleet) accept an empty/plain 2xx body, but never the ALB default", () => {
    // fleek /health answers 200 with content-length: 0 — that IS its signal.
    expect(classifyProbeBody('', 'plain')).toBe('healthy');
    expect(classifyProbeBody(undefined, 'plain')).toBe('healthy');
    expect(classifyProbeBody('OK', 'plain')).toBe('healthy');
    // The ALB guard still wins, so a mis-mapped host can never sneak through.
    expect(classifyProbeBody('dev-account-alb', 'plain')).toBe('alb-default');
    // An empty body is still NOT health for a JSON API.
    expect(classifyProbeBody('', 'api')).toBe('empty');
  });

  it('still fails an explicitly unhealthy status (allowlist, not "anything non-error")', () => {
    expect(classifyProbeBody('{"status":"degraded","service":"IAM API"}', 'api')).toBe('unexpected');
    expect(classifyProbeBody('{"status":"down","service":"IAM API"}', 'api')).toBe('unexpected');
  });

  it('rejects wrong-shaped, empty, and cross-kind bodies', () => {
    expect(classifyProbeBody('{"status":"degraded","service":"X"}', 'api')).toBe('unexpected');
    expect(classifyProbeBody('<!doctype html>', 'api')).toBe('unexpected'); // HTML where JSON is required
    expect(classifyProbeBody('{"status":"ok","service":"X"}', 'frontend')).toBe('unexpected');
    expect(classifyProbeBody('', 'api')).toBe('empty');
    expect(classifyProbeBody(undefined, 'api')).toBe('empty');
  });
});

describe('ECS platform verdicts (pure)', () => {
  it('healthy only when ACTIVE, fully running, and rollout complete', () => {
    expect(classifyEcsState({ running: 2, desired: 2, status: 'ACTIVE', rollout: 'COMPLETED' }).healthy).toBe(true);
    expect(classifyEcsState({ running: 1, desired: 2, status: 'ACTIVE', rollout: 'COMPLETED' })).toMatchObject({
      healthy: false,
      summary: expect.stringContaining('under-running 1/2'),
    });
    // A routine in-flight deploy at full task count is noted, NOT failed.
    expect(classifyEcsState({ running: 2, desired: 2, status: 'ACTIVE', rollout: 'IN_PROGRESS' })).toMatchObject({
      healthy: true,
      summary: expect.stringContaining('rollout IN_PROGRESS'),
    });
    // A genuinely failed rollout still fails.
    expect(classifyEcsState({ running: 2, desired: 2, status: 'ACTIVE', rollout: 'FAILED' }).healthy).toBe(false);
    expect(classifyEcsState({ running: 0, desired: 0, status: 'ACTIVE' })).toMatchObject({
      healthy: false,
      summary: expect.stringContaining('scaled to zero'),
    });
    expect(classifyEcsState(undefined)).toMatchObject({ healthy: false, summary: expect.stringContaining('no such ECS service') });
  });
});

describe('env verify --ecs', () => {
  const ecsAws = (state: Record<string, unknown> | null): void => {
    const fake = {
      async json(args: string[]): Promise<unknown> {
        if (args[0] === 'sts') return '396913734878';
        if (args[1] === 'describe-services') return state;
        return null;
      },
      async lambdaInvoke(): Promise<unknown> {
        throw new Error('unexpected');
      },
      portForward(): never {
        throw new Error('unexpected');
      },
    };
    vi.spyOn(BaseCommand.prototype as unknown as { getEnvAws: () => unknown }, 'getEnvAws').mockReturnValue(fake);
  };

  it('reports the ECS verdict alongside the HTTP result', async () => {
    ecsAws({ running: 2, desired: 2, status: 'ACTIVE', rollout: 'COMPLETED' });

    await expect(EnvVerify.run(['--env', 'dev', '--ecs'], config)).resolves.toBeUndefined();
    expect(text()).toMatch(/connect-api.*ecs 2\/2/s);
    expect(text()).toContain('verify passed');
  });

  it('FAILS a service whose HTTP is green but whose ECS is under-running', async () => {
    ecsAws({ running: 0, desired: 2, status: 'ACTIVE', rollout: 'IN_PROGRESS' }); // under-running ⇒ real failure

    await expect(EnvVerify.run(['--env', 'dev', '--ecs'], config)).rejects.toThrow(/env verify FAILED/);
    expect(text()).toContain('ECS: under-running 0/2');
  });

  it('refuses on the wrong AWS account before any ECS call', async () => {
    const fake = {
      async json(args: string[]): Promise<unknown> {
        if (args[0] === 'sts') return '531314149529'; // prod
        throw new Error('must not query ECS on an account mismatch');
      },
      async lambdaInvoke(): Promise<unknown> {
        throw new Error('unexpected');
      },
      portForward(): never {
        throw new Error('unexpected');
      },
    };
    vi.spyOn(BaseCommand.prototype as unknown as { getEnvAws: () => unknown }, 'getEnvAws').mockReturnValue(fake);

    await expect(EnvVerify.run(['--env', 'dev', '--ecs'], config)).rejects.toThrow(/account mismatch/);
  });
});

describe('env verify — the gate', () => {
  it('passes when every routed service answers a real health body', async () => {
    await expect(EnvVerify.run(['--env', 'dev'], config)).resolves.toBeUndefined();

    expect(text()).toContain('verify passed');
    expect(probed).toContain('https://iam.wootdev.com/health');
    expect(probed).toContain('https://dash.wootdev.com/');
    // rtsm IS probed now — on its own cluster host, not the shared domain.
    expect(probed).toContain('https://chi-1.rtsm.wootdev.com/health');
    // connect-web is probed at its Amplify branch URL.
    expect(probed).toContain('https://dev.d2ezd4i8b4uexc.amplifyapp.com/');
  });

  it('FAILS (non-zero) when a service returns the ALB default — the 200-is-not-health case', async () => {
    installProber({ 'programs-api': albDefault });

    await expect(
      EnvVerify.run(['--env', 'dev'], config),
    ).rejects.toThrow(/env verify FAILED.*programs-api/s);
    expect(text()).toContain('not routed');
  });

  it('FAILS on an unreachable service and on a non-2xx', async () => {
    installProber({ 'sessions-api': { ok: false } });
    await expect(EnvVerify.run(['--env', 'dev'], config)).rejects.toThrow(
      /sessions-api/,
    );
    expect(text()).toContain('unreachable');
  });

  it('--tolerate downgrades a failure to a non-fatal note', async () => {
    installProber({ 'ads-adm-api': albDefault });

    await expect(
      EnvVerify.run(['--env', 'dev', '--tolerate', 'ads-adm-api'], config),
    ).resolves.toBeUndefined();
    expect(text()).toContain('(tolerated)');
    expect(text()).toContain('verify passed');
  });

  it('every mapped service now has an HTTP route on dev', async () => {
    await expect(EnvVerify.run(['--env', 'dev'], config)).resolves.toBeUndefined();
    expect(text()).not.toContain('no public route');
    expect(text()).toContain('verify passed');
  });

  it('--org asserts the seed skeleton and passes when intact', async () => {
    await expect(
      EnvVerify.run(
        ['--env', 'dev', '--org', 'emptyOrg', '--url', 'iam=postgres://iam'],
        config,
      ),
    ).resolves.toBeUndefined();
    expect(text()).toContain('org skeleton intact');
  });

  it('--org FAILS the gate when the skeleton is broken', async () => {
    installEnvPsql({ memb: false });

    await expect(
      EnvVerify.run(
        ['--env', 'dev', '--org', 'emptyOrg', '--url', 'iam=postgres://iam'],
        config,
      ),
    ).rejects.toThrow(/org skeleton/);
    expect(text()).toContain('MISSING: admin membership');
  });

  it('--org without the iam connection refuses up front', async () => {
    await expect(EnvVerify.run(['--env', 'dev', '--org', 'emptyOrg'], config)).rejects.toThrow(/needs the iam connection/);
  });

  it('--org rejects a non-catalog slug', async () => {
    await expect(
      EnvVerify.run(['--env', 'dev', '--org', 'jennys-org', '--url', 'iam=postgres://iam'], config),
    ).rejects.toThrow(/not a known fixture org/);
  });
});
