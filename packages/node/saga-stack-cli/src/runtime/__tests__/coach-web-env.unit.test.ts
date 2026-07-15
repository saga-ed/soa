/**
 * coach-web-env prelaunch hook (soa#300, soa#298). The fs is injected, so this asserts
 * the mode-for-mode behaviour with NO real filesystem: the per-slot `.env.local`
 * contents (offset PUBLIC_* URLs at slot 0 and slot 2), the TUNNEL lane's public hosts
 * (incl. the stale-local-file shadow this fix exists to kill), and the no-app no-op.
 */

import { describe, expect, it } from 'vitest';
import {
  coachWebEnvLocalContents,
  coachWebEnvLocalPath,
  syncCoachWebEnvLocal,
} from '../coach-web-env.js';
import type { CoachWebFs } from '../coach-web-env.js';
import type { ServiceId } from '../../core/manifest/index.js';

const COACH_WEB = '/repo/coach/apps/web/coach-web';
const ENV_LOCAL = coachWebEnvLocalPath(COACH_WEB);
/** A representative tunnel domain (`<moniker>.<VMS_BASE>`). */
const TD = 'sk.vms.wootdev.com';

/** A fake fs with controllable existence + recorded mutations. */
function fakeFs(opts: { hasApp?: boolean } = {}): {
  fs: CoachWebFs;
  removed: string[];
  written: Array<{ path: string; contents: string }>;
} {
  const removed: string[] = [];
  const written: Array<{ path: string; contents: string }> = [];
  const fs: CoachWebFs = {
    existsDir: () => opts.hasApp ?? true,
    write: (path, contents) => written.push({ path, contents }),
    remove: (path) => removed.push(path),
  };
  return { fs, removed, written };
}

/** slot-N port map for the coach-web-backing services (base ports + offset). */
const slotPorts = (offset: number): Partial<Record<ServiceId, number>> => ({
  'iam-api': 3010 + offset,
  'coach-api': 6105 + offset,
  'saga-dash': 8900 + offset,
});

/** Parse a KEY=VALUE `.env` string into a lookup, ignoring `#` comments/blank lines. */
function parseEnv(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of contents.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

describe('syncCoachWebEnvLocal', () => {
  it('no-ops when the coach-web app dir is absent (coach not checked out here)', () => {
    const { fs, removed, written } = fakeFs({ hasApp: false });
    const res = syncCoachWebEnvLocal({ coachWebRoot: COACH_WEB, stackPorts: slotPorts(0) }, fs);
    expect(res.action).toBe('noop-no-app');
    expect(removed).toEqual([]);
    expect(written).toEqual([]);
  });

  it('--tunnel: WRITES the PUBLIC tunnel hosts (NOT localhost) so a remote browser boots', () => {
    // soa#298. tunnelOverlay() sets PUBLIC_COACH_API_URL in the LAUNCH ENV, which
    // SvelteKit ignores ($env/static/public inlines `.env.local`/`.env`) — so this
    // file is the only thing a remote browser actually sees.
    const { fs, removed, written } = fakeFs();
    const res = syncCoachWebEnvLocal(
      { coachWebRoot: COACH_WEB, tunnel: true, tunnelDomain: TD, stackPorts: slotPorts(0) },
      fs,
    );
    expect(res.action).toBe('wrote-tunnel');
    expect(removed).toEqual([]);
    expect(written).toHaveLength(1);

    const env = parseEnv(written[0].contents);
    expect(env.PUBLIC_COACH_API_URL).toBe(`https://coach-api.${TD}`);
    // iam MUST flip too: coach-web fetches whoami DIRECT from iam (api/session.ts),
    // so leaving it at the `.env` default (https://iam.wootdev.com) 503s the remote
    // browser — the gap tunnelOverlay() could not close.
    expect(env.PUBLIC_IAM_API_URL).toBe(`https://iam.${TD}`);
    expect(env.PUBLIC_DASHBOARD_URL).toBe(`https://dash.${TD}`);
    // No `login` host exists in tunnel.sh SERVICES ⇒ login points at iam in both lanes.
    expect(env.PUBLIC_LOGIN_URL).toBe(`https://iam.${TD}`);
    // The whole point: not one localhost URL survives into a remote browser's bundle.
    expect(written[0].contents).not.toContain('localhost');
  });

  it('--tunnel: OVERWRITES a stale LOCAL .env.local (the shadow that broke tunnel coach)', () => {
    // The regression this fix exists for: `.env.local` > `.env` > launch env, so a file
    // left by an earlier LOCAL run would pin a remote browser to localhost. Same path,
    // rewritten — never appended to, never left in place.
    const { fs, written } = fakeFs();
    syncCoachWebEnvLocal({ coachWebRoot: COACH_WEB, stackPorts: slotPorts(0) }, fs); // local run
    syncCoachWebEnvLocal(
      { coachWebRoot: COACH_WEB, tunnel: true, tunnelDomain: TD, stackPorts: slotPorts(0) },
      fs,
    ); // then tunnel

    expect(written).toHaveLength(2);
    expect(written[1].path).toBe(written[0].path); // same file, so the stale one is gone
    expect(written[0].contents).toContain('http://localhost:6105');
    expect(written[1].contents).not.toContain('localhost');
  });

  it('--tunnel: ignores stackPorts entirely (tunnel hosts are static labels)', () => {
    // A tunnel run must not degrade to a `.env` REMOTE default just because a port is
    // unresolved — every host is a tunnel.sh label, so all four vars are always written.
    const { fs, written } = fakeFs();
    const res = syncCoachWebEnvLocal(
      { coachWebRoot: COACH_WEB, tunnel: true, tunnelDomain: TD, stackPorts: {} },
      fs,
    );
    expect(res.action).toBe('wrote-tunnel');
    const env = parseEnv(written[0].contents);
    expect(Object.keys(env).sort()).toEqual([
      'PUBLIC_COACH_API_URL',
      'PUBLIC_DASHBOARD_URL',
      'PUBLIC_IAM_API_URL',
      'PUBLIC_LOGIN_URL',
    ]);
  });

  it('--tunnel with NO domain: REMOVES a stale .env.local rather than pinning localhost', () => {
    // Not reachable via the facade (it always pairs tunnel+domain), but if it were, a
    // leftover LOCAL file would shadow `.env` and send a remote browser to localhost.
    // Degrade to coach-web's own `.env` defaults instead of a knowably-wrong host.
    const { fs, removed, written } = fakeFs();
    const res = syncCoachWebEnvLocal(
      { coachWebRoot: COACH_WEB, tunnel: true, stackPorts: slotPorts(0) },
      fs,
    );
    expect(res.action).toBe('noop-tunnel');
    expect(written).toEqual([]);
    expect(removed).toEqual([`${COACH_WEB}/.env.local`]);
  });

  it('slot 0: WRITES .env.local with the LOCAL (base-port) PUBLIC_* URLs', () => {
    const { fs, written, removed } = fakeFs();
    const res = syncCoachWebEnvLocal({ coachWebRoot: COACH_WEB, slot: 0, stackPorts: slotPorts(0) }, fs);
    expect(res).toEqual({ action: 'wrote', path: ENV_LOCAL });
    expect(removed).toEqual([]);
    expect(written).toHaveLength(1);
    const env = parseEnv(written[0].contents);
    // base ports: iam 3010, coach-api 6105, saga-dash 8900. Remote wootdev defaults gone.
    expect(env.PUBLIC_IAM_API_URL).toBe('http://localhost:3010');
    expect(env.PUBLIC_COACH_API_URL).toBe('http://localhost:6105');
    expect(env.PUBLIC_DASHBOARD_URL).toBe('http://localhost:8900');
    // PUBLIC_LOGIN_URL → iam (the whoami 401 challenge login lives at iam's /demo).
    expect(env.PUBLIC_LOGIN_URL).toBe('http://localhost:3010');
    // never leaks a remote host.
    expect(written[0].contents).not.toContain('wootdev.com');
    expect(written[0].contents.endsWith('\n')).toBe(true);
  });

  it('slot 2: WRITES .env.local with the OFFSET PUBLIC_* URLs (offset 2000)', () => {
    const { fs, written } = fakeFs();
    const res = syncCoachWebEnvLocal({ coachWebRoot: COACH_WEB, slot: 2, stackPorts: slotPorts(2000) }, fs);
    expect(res).toEqual({ action: 'wrote', path: ENV_LOCAL });
    const env = parseEnv(written[0].contents);
    // slot 2 = base + 2000: iam 5010, coach-api 8105, saga-dash 10900.
    expect(env.PUBLIC_IAM_API_URL).toBe('http://localhost:5010');
    expect(env.PUBLIC_COACH_API_URL).toBe('http://localhost:8105');
    expect(env.PUBLIC_DASHBOARD_URL).toBe('http://localhost:10900');
    expect(env.PUBLIC_LOGIN_URL).toBe('http://localhost:5010');
    // base-port (slot 0) values must NOT leak through at an offset slot.
    expect(env.PUBLIC_IAM_API_URL).not.toContain(':3010');
    expect(env.PUBLIC_COACH_API_URL).not.toContain(':6105');
  });

  it('coachWebEnvLocalContents omits a PUBLIC_ var whose backing service has no resolved port', () => {
    // no saga-dash port ⇒ PUBLIC_DASHBOARD_URL dropped (coach-web keeps its .env default),
    // never `localhost:undefined`.
    const contents = coachWebEnvLocalContents({ 'iam-api': 3010, 'coach-api': 6105 });
    expect(contents).not.toContain('undefined');
    const env = parseEnv(contents);
    expect(env.PUBLIC_DASHBOARD_URL).toBeUndefined();
    expect(env.PUBLIC_IAM_API_URL).toBe('http://localhost:3010');
  });

  it('defaults the real fs when none is injected (does not throw on a missing dir)', () => {
    // /no/such/coach-web has no app dir → noop-no-app via the real fs.
    const res = syncCoachWebEnvLocal({ coachWebRoot: '/no/such/coach-web-xyz', stackPorts: slotPorts(0) });
    expect(res.action).toBe('noop-no-app');
  });
});
