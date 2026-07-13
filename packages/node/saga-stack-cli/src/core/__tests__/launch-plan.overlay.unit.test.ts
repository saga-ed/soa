/**
 * launch-plan lane-OVERLAY unit tests (Phase 2, saga-ed/soa#214) — the
 * `sandbox_env` / `tunnel_env` port audit, in code.
 *
 * Runs against the REAL frozen manifest + `defaultLaunchContext`, resolving each
 * service's launch env with a sandbox and/or tunnel input set, and asserts the
 * resolved env carries EXACTLY the KEY=VAL overrides up.sh's `sandbox_env`
 * (~1216-1260) / `tunnel_env` (~1292-1366) splat onto that service's launch line.
 *
 * PURE: no docker/pnpm/network — `defaultLaunchContext` takes fake repo roots.
 */

import { describe, expect, it } from 'vitest';
import { defaultLaunchContext, resolveLaunchEnv } from '../launch-plan.js';
import type { LaunchContextInputs } from '../launch-plan.js';
import type { RepoKey, ServiceId } from '../manifest/index.js';

const REPO_ROOTS: Record<RepoKey, string> = {
  SOA: '/w/soa',
  ROSTERING: '/w/rostering',
  PROGRAM_HUB: '/w/program-hub',
  SAGA_DASH: '/w/saga-dash',
  COACH: '/w/coach',
  SDS: '/w/student-data-system',
  QBOARD: '/w/qboard',
  RTSM: '/w/rtsm',
  FLEEK: '/w/fleek',
};

const baseInputs: LaunchContextInputs = {
  repoRoots: REPO_ROOTS,
  vendorDir: '/w/vendor',
};

const envFor = (id: ServiceId, extra: Partial<LaunchContextInputs>): Record<string, string> =>
  resolveLaunchEnv(id, 'stack', defaultLaunchContext({ ...baseInputs, ...extra }));

describe('sandbox_env overlay (--sandbox <name>)', () => {
  const SB = { sandbox: { name: 'foo' } } satisfies Partial<LaunchContextInputs>;

  it('sis-api: iam URL flip (/trpc + /oauth) + originates the preview header', () => {
    const e = envFor('sis-api', SB);
    expect(e.IAM_BASEURL).toBe('https://iam.wootdev.com/trpc');
    expect(e.IAM_TOKENURL).toBe('https://iam.wootdev.com/v1/oauth/token');
    expect(e.PREVIEW_ORIGINATE_MAP).toBe('x-saga-preview-iam-api=sandbox-foo');
  });

  it('programs-api: IAM_API_URL flip + originate header', () => {
    const e = envFor('programs-api', SB);
    expect(e.IAM_API_URL).toBe('https://iam.wootdev.com');
    expect(e.PREVIEW_ORIGINATE_MAP).toBe('x-saga-preview-iam-api=sandbox-foo');
  });

  it('scheduling-api / sessions-api: URL flip ONLY (no originate — no outbound iam S2S)', () => {
    for (const id of ['scheduling-api', 'sessions-api'] as const) {
      const e = envFor(id, SB);
      expect(e.IAM_API_URL).toBe('https://iam.wootdev.com');
      expect(e.PREVIEW_ORIGINATE_MAP).toBeUndefined();
    }
  });

  it('honours a non-default SANDBOX_BASE', () => {
    const e = envFor('sis-api', { sandbox: { name: 'foo', base: 'wootdev.io' } });
    expect(e.IAM_BASEURL).toBe('https://iam.wootdev.io/trpc');
  });

  it('iam-api itself is NOT repointed (runs locally); no overlay with no --sandbox', () => {
    expect(envFor('iam-api', SB).PREVIEW_ORIGINATE_MAP).toBeUndefined();
    // pure-local: sis-api keeps its base (local) iam URLs.
    expect(envFor('sis-api', {}).IAM_BASEURL).toBe('http://localhost:3010/trpc');
    expect(envFor('sis-api', {}).PREVIEW_ORIGINATE_MAP).toBeUndefined();
  });
});

describe('tunnel_env overlay (--tunnel)', () => {
  const TD = 'm1.vms.wootdev.com';
  const TUN = { tunnel: { domain: TD } } satisfies Partial<LaunchContextInputs>;

  it('iam-api: cookie domain + CORS tunnel origins + tunnelled mail base', () => {
    const e = envFor('iam-api', TUN);
    expect(e.AUTH_SESSIONCOOKIEDOMAIN).toBe(`.${TD}`);
    expect(e.CORS_ORIGIN).toBe(
      `http://localhost:8900,http://localhost:6210,https://dash.${TD},https://connect.${TD}`,
    );
    expect(e.MAIL_FRONTEND_BASE_URL).toBe(`https://iam.${TD}/demo`);
  });

  it('sis-api: CORS gains the iam demo + tunnel origins', () => {
    const e = envFor('sis-api', TUN);
    expect(e.CORS_ORIGIN).toBe(
      `http://localhost:8900,http://localhost:3010,https://dash.${TD},https://iam.${TD}`,
    );
  });

  it('programs/scheduling/sessions/ads-adm: CORS + JANUS_LOGIN_HOST → tunnelled iam demo', () => {
    for (const id of ['programs-api', 'scheduling-api', 'sessions-api', 'ads-adm-api'] as const) {
      const e = envFor(id, TUN);
      expect(e.CORS_ORIGIN).toBe(`http://localhost:8900,https://dash.${TD}`);
      expect(e.JANUS_LOGIN_HOST).toBe(`iam.${TD}/demo`);
    }
  });

  it('connect-api: allowed origins + public URL + fleek cluster AV topology (no creds by default)', () => {
    const e = envFor('connect-api', TUN);
    expect(e.ALLOWED_ORIGINS).toBe(`http://localhost:6210,https://connect.${TD}`);
    expect(e.PUBLIC_API_URL).toBe(`https://connect-api.${TD}`);
    expect(e.JANUS_LOGIN_HOST).toBe(`iam.${TD}/demo`);
    expect(e.LIVEKIT_URL).toBe('wss://chi-1.fleek.wootdev.com');
    expect(e.FLEEK_TOPOLOGY_JSON).toContain('fleek.wootdev.com');
    // no creds resolved ⇒ signs with the base dev key (up.sh no-creds branch).
    expect(e.LIVEKIT_API_KEY).toBe('devkey');
  });

  it('connect-api: real cluster creds overlay when the runtime resolved them', () => {
    const e = envFor('connect-api', {
      tunnel: { domain: TD, lkKey: 'realkey', lkSecret: 'realsecret' },
    });
    expect(e.LIVEKIT_API_KEY).toBe('realkey');
    expect(e.LIVEKIT_API_SECRET).toBe('realsecret');
  });

  it('connect-web: VITE_* deps flip to the tunnel hosts + vite host allow', () => {
    const e = envFor('connect-web', TUN);
    expect(e.VITE_CONNECTV3_API_URL).toBe(`https://connect-api.${TD}`);
    expect(e.VITE_IAM_API_URL).toBe(`https://iam.${TD}`);
    expect(e.VITE_RTSM_BOOTSTRAP_URL).toBe(`https://rtsm.${TD}`);
    expect(e.VITE_DASHBOARD_URL).toBe(`https://dash.${TD}`);
    expect(e.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS).toBe(`connect.${TD}`);
  });

  it('saga-dash: vite host allow for the tunnel dash host', () => {
    expect(envFor('saga-dash', TUN).__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS).toBe(`dash.${TD}`);
  });

  it('coach-api: CORS allow-list appends the BARE tunnel domain, keeping the localhost host', () => {
    const e = envFor('coach-api', TUN);
    // up.sh: "$COACH_WEB_HOST,$TUNNEL_DOMAIN" — localhost host retained, bare
    // domain admits coach.${TD} (api-core hostname match), no per-label enum.
    expect(e.EXPRESS_SERVER_CORSALLOWEDDOMAINS).toBe(`localhost,${TD}`);
  });

  it('coach-web: browser-side API URL (label coach-api) + vite host allow (label coach)', () => {
    const e = envFor('coach-web', TUN);
    // Labels are HARDCODED to up.sh's, NOT the manifest tunnelSlug (coach-web).
    expect(e.PUBLIC_COACH_API_URL).toBe(`https://coach-api.${TD}`);
    expect(e.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS).toBe(`coach.${TD}`);
  });

  it('rtsm-api: FLEET_CONFIG_PATH override ONLY when a generated tunnel fleet path is supplied', () => {
    // no fleet path ⇒ keeps the base local fleet.
    expect(envFor('rtsm-api', TUN).FLEET_CONFIG_PATH).toBe(
      '/w/vendor/rtsm-fleet-local.json',
    );
    // with the generated path ⇒ points at the tunnel fleet file.
    const e = envFor('rtsm-api', { tunnel: { domain: TD, rtsmFleetPath: '/state/rtsm-fleet-tunnel.json' } });
    expect(e.FLEET_CONFIG_PATH).toBe('/state/rtsm-fleet-tunnel.json');
  });
});

describe('sandbox + tunnel compose (tunnel wins last, matching up.sh splat order)', () => {
  it('sis-api under BOTH: sandbox iam URLs + tunnel CORS both present', () => {
    const e = envFor('sis-api', { sandbox: { name: 'foo' }, tunnel: { domain: 'm1.vms.wootdev.com' } });
    // sandbox_env flip …
    expect(e.IAM_BASEURL).toBe('https://iam.wootdev.com/trpc');
    // … and tunnel_env CORS (splatted after, last-wins on the shared key).
    expect(e.CORS_ORIGIN).toContain('https://dash.m1.vms.wootdev.com');
  });
});
