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
import type { DeployedServiceDef } from '../../../core/env/index.js';
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

  it('prod uses the SAME <host>.<domain> convention — no curated prod host map', () => {
    // The issue assumed prod was multi-apex; live probing refuted it. If this
    // ever needs a per-service prod entry, the premise changed, not the code.
    const byId = Object.fromEntries(buildEnvHealthProbes('saga.org', 'prod').map((p) => [p.id, p.url]));
    expect(byId['iam-api']).toBe('https://iam.saga.org/health');
    expect(byId['sis-api']).toBe('https://sis.saga.org/health');
    expect(byId['programs-api']).toBe('https://programs-api.saga.org/health');
    expect(byId['coach-web']).toBe('https://coach.saga.org/');
  });

  it('never probes the wootdev.com recording fleets on a PROD run', () => {
    // fleek/fleek-recorder/rtsm-api pin `fqdn` to *.wootdev.com — a DEV-account
    // fleet. Prod runs its own (`recorder_cluster_prod`,
    // `av-recorder-cluster-prod-v3`). Probing the dev host during a prod run is
    // a false signal BOTH ways: green while prod's recorder is down, red while
    // dev's is down and prod is fine. They must be absent from prod entirely —
    // not merely un-gated, which would still report the wrong fleet's health.
    const ids = buildEnvHealthProbes('saga.org', 'prod').map((p) => p.id);
    expect(ids).not.toContain('fleek');
    expect(ids).not.toContain('fleek-recorder');
    expect(ids).not.toContain('rtsm-api');
    // …and no prod probe may target a wootdev.com host by any route.
    const urls = buildEnvHealthProbes('saga.org', 'prod')
        .map((p) => p.url)
        .filter((u): u is string => u !== null);
    expect(urls.filter((u) => u.includes('wootdev.com'))).toEqual([]);
    // Still required where they ARE the right fleet.
    expect(buildEnvHealthProbes('wootdev.com', 'dev').map((p) => p.id)).toContain('fleek');
    expect(buildEnvHealthProbes('saga-training.org', 'training').map((p) => p.id)).toContain('rtsm-api');
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

describe('per-env service scope (I#375)', () => {
  const ids = (envName: string, domain: string): string[] =>
    buildEnvHealthProbes(domain, envName).map((p) => p.id);

  it('OMITS services that are not deployed to the env, and only there', () => {
    // Absent from prod-shared AND NXDOMAIN ⇒ genuinely not deployed to prod.
    for (const id of ['content-api', 'transcripts-api']) {
      expect(ids('prod', 'saga.org')).not.toContain(id);
      expect(ids('dev', 'wootdev.com')).toContain(id);
      expect(ids('training', 'saga-training.org')).toContain(id);
    }
  });

  it('REPORTS ads-adm-api on prod even though it is not deployed there yet (sds#369)', () => {
    // Its prod deploy is actively being dispatched, so the absence is a state
    // the gate must SHOW (and the deploy's acceptance signal when it flips),
    // not a scope-out that keeps `verify --env prod` green around the very
    // service whose deploy is being debugged. Required, not optional — accept
    // the interim red with `--tolerate ads-adm-api`.
    const prod = Object.fromEntries(buildEnvHealthProbes('saga.org', 'prod').map((p) => [p.id, p]));
    expect(prod['ads-adm-api']!.url).toBe('https://ads-adm-api.saga.org/health');
    expect(prod['ads-adm-api']!.optional).toBe(false);
    expect(prod['ads-adm-api']!.ecsService).toBe('sds-ads-adm-api');
  });

  it('scoping OUT of prod does NOT weaken the dev gate (scope is not `optional`)', () => {
    // The trap this field exists to avoid: marking the three optional would
    // have let them fail silently on dev, where they really do run.
    const dev = Object.fromEntries(buildEnvHealthProbes('wootdev.com', 'dev').map((p) => [p.id, p]));
    expect(dev['content-api']!.optional).toBe(false);
    expect(dev['ads-adm-api']!.optional).toBe(false);
    // transcripts-api was already optional before this change — unchanged.
    expect(dev['transcripts-api']!.optional).toBe(true);
  });

  it('gives EVERY prod service an HTTP route — no stale no-public-route entries', () => {
    // Regression for the three services recorded as unrouted in prod that were
    // in fact routed the whole time (Seth, 2026-07-29). A stale "no public
    // route" is not a harmless omission: coach-api/connect-api FAILED the gate
    // outright, so `verify --env prod` was red on a healthy fleet.
    const prod = Object.fromEntries(buildEnvHealthProbes('saga.org', 'prod').map((p) => [p.id, p]));
    expect(prod['coach-api']!.url).toBe('https://coach-api.saga.org/health');
    expect(prod['connect-api']!.url).toBe('https://connectv3-api.saga.org/connectv3/v1/health');
    // Prod has a custom domain (connectv3., NOT connect.); dev/training do not.
    expect(prod['connect-web']!.url).toBe('https://connectv3.saga.org/');
    // Nothing in prod is unroutable or un-gated any more.
    for (const p of buildEnvHealthProbes('saga.org', 'prod')) {
      expect(p.url, `${p.id} has no prod URL`).not.toBeNull();
      expect(p.optional, `${p.id} is un-gated in prod`).toBe(false);
    }
    // …while dev/training keep their own distinct hosts.
    const dev = Object.fromEntries(buildEnvHealthProbes('wootdev.com', 'dev').map((p) => [p.id, p.url]));
    expect(dev['coach-api']).toBe('https://coach-api.wootdev.com/health');
    expect(dev['connect-api']).toBe('https://connectv3-api.wootdev.com/connectv3/v1/health');
    expect(dev['connect-web']).toBe('https://dev.d2ezd4i8b4uexc.amplifyapp.com/');
  });

  it('reports a DEPLOYED-but-unrouted service instead of dropping it (noPublicRouteEnvs)', () => {
    // No live service needs this today, so it is pinned against a fixture: the
    // mechanism must keep working for the next host that loses its DNS record.
    // Dropping such a service (via `envs`) would hide a real outage — it stays
    // listed with url null, still REQUIRED, judged by --ecs.
    const svc: DeployedServiceDef[] = [
      { id: 'x-api', host: 'x-api', noPublicRouteEnvs: ['prod'], healthPath: '/health', kind: 'api', ecsService: 'x' },
    ];
    const prod = buildEnvHealthProbes('saga.org', 'prod', svc)[0]!;
    expect(prod.url).toBeNull();
    expect(prod.optional).toBe(false);
    expect(prod.ecsService).toBe('x');
    expect(buildEnvHealthProbes('wootdev.com', 'dev', svc)[0]!.url).toBe('https://x-api.wootdev.com/health');
  });

  it('un-gates a service ONLY in the env where it has no signal at all (optionalEnvs)', () => {
    // Also fixture-pinned now that prod's connect-web is checkable. The rule:
    // un-gating one env must never weaken the envs where the service IS
    // verifiable, or a real outage there passes silently.
    const svc: DeployedServiceDef[] = [
      {
        id: 'x-web',
        fqdnByEnv: { dev: 'dev.example.amplifyapp.com' },
        optionalEnvs: ['prod'],
        healthPath: '/',
        kind: 'frontend',
      },
    ];
    const prod = buildEnvHealthProbes('saga.org', 'prod', svc)[0]!;
    expect(prod.url).toBeNull();
    expect(prod.optional).toBe(true);
    expect(prod.ecsService).toBeUndefined();
    expect(prod.ecsServiceName).toBeUndefined();
    const dev = buildEnvHealthProbes('wootdev.com', 'dev', svc)[0]!;
    expect(dev.optional).toBe(false);
    expect(dev.url).toBe('https://dev.example.amplifyapp.com/');
  });

  it('carries the per-env ABSOLUTE ECS name only where one is declared', () => {
    const prod = Object.fromEntries(buildEnvHealthProbes('saga.org', 'prod').map((p) => [p.id, p]));
    // No service declares an override today — coach-api used to pin
    // `coach-coach-api-canary`, but prod-shared runs `coach-coach-api-main`.
    expect(prod['coach-api']!.ecsServiceName).toBeUndefined();
    expect(prod['coach-api']!.ecsService).toBe('coach-coach-api');
    // Everything else composes from the prefix — no global suffix override.
    expect(prod['iam-api']!.ecsServiceName).toBeUndefined();
    expect(prod['iam-api']!.ecsService).toBe('rostering-iam-api');
    const dev = Object.fromEntries(buildEnvHealthProbes('wootdev.com', 'dev').map((p) => [p.id, p]));
    expect(dev['coach-api']!.ecsServiceName).toBeUndefined();
    expect(dev['coach-api']!.ecsService).toBe('coach-coach-api');
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

  it('--env prod asks ECS for the right service names — all on the -main suffix', async () => {
    const asked: string[] = [];
    const fake = {
      async json(args: string[]): Promise<unknown> {
        if (args[0] === 'sts') return '531314149529'; // the prod account
        if (args[1] === 'describe-services') {
          asked.push(args[args.indexOf('--services') + 1]!);
          expect(args[args.indexOf('--cluster') + 1]).toBe('prod-shared'); // no arm cluster in prod
          return { running: 2, desired: 2, status: 'ACTIVE', rollout: 'COMPLETED' };
        }
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

    // NO --tolerate: a healthy prod fleet must pass on its own. If this ever
    // needs one, the gate has become a thing operators route around.
    await expect(EnvVerify.run(['--env', 'prod', '--ecs'], config)).resolves.toBeUndefined();

    // prod's shared mesh uses the SAME `-main` suffix as dev's…
    expect(asked).toContain('rostering-iam-api-main');
    expect(asked).toContain('qboard-connectv3-api-main');
    // …and coach is no exception: `aws ecs list-services --cluster prod-shared`
    // lists `coach-coach-api-main` and no canary, so it composes like the rest.
    expect(asked).toContain('coach-coach-api-main');
    expect(asked).not.toContain('coach-coach-api-canary');
    // Services scoped out of prod are never asked about at all…
    expect(asked.some((s) => s.includes('content-api') || s.includes('transcripts'))).toBe(false);
    // …but ads-adm-api IS in prod scope now (deploy in flight, sds#369) and
    // composes on the standard -main suffix like the rest of the mesh.
    expect(asked).toContain('sds-ads-adm-api-main');
    // Nothing in prod reads as unroutable any more — the three services that
    // once did are probed over HTTP like the rest.
    expect(text()).not.toContain('no public route');
    expect(probed).toContain('https://coach-api.saga.org/health');
    expect(probed).toContain('https://connectv3-api.saga.org/connectv3/v1/health');
    expect(probed).toContain('https://connectv3.saga.org/');
    // connect-web is an Amplify SPA — HTTP is its only signal, never ECS.
    expect(asked.some((s) => s.includes('connect-web'))).toBe(false);
    expect(text()).toContain('verify passed');
  });

  it('--env prod does NOT green a service whose HTTP is fine but whose ECS is bad', async () => {
    const fake = {
      async json(args: string[]): Promise<unknown> {
        if (args[0] === 'sts') return '531314149529';
        if (args[1] === 'describe-services') {
          return args.includes('coach-coach-api-main') ? null : { running: 1, desired: 1, status: 'ACTIVE', rollout: 'COMPLETED' };
        }
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

    // A healthy /health cannot cover for a missing ECS service: the platform
    // pass is the truth HTTP cannot see (stale target behind a dead service).
    await expect(EnvVerify.run(['--env', 'prod', '--ecs'], config)).rejects.toThrow(/env verify FAILED.*coach-api/s);
    expect(text()).toContain('no such ECS service');
    expect(text()).toContain('1 required service(s) unhealthy');
  });

  it('--env prod passes on HTTP alone — every prod service is routed', async () => {
    // The bug this replaces: coach-api/connect-api carried a stale "no public
    // route", so a plain `ss env verify --env prod` FAILED on a healthy fleet
    // and could only be worked around with --tolerate.
    await expect(EnvVerify.run(['--env', 'prod'], config)).resolves.toBeUndefined();
    expect(text()).not.toContain('no public route');
    expect(probed).toContain('https://coach-api.saga.org/health');
    expect(probed).toContain('https://connectv3-api.saga.org/connectv3/v1/health');
    expect(probed).toContain('https://connectv3.saga.org/');
    // …alongside the services that were already probed on the plain apex.
    expect(probed).toContain('https://iam.saga.org/health');
    // ads-adm-api is probed in prod too (deploy in flight, sds#369).
    expect(probed).toContain('https://ads-adm-api.saga.org/health');
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
