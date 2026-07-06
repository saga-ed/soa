/**
 * computeClosure + launchOrder unit tests (plan §2.3, §6.4).
 *
 * Runs against the REAL frozen manifest (the data under test). Asserts the
 * N-of-M dependency-closure rules the bash launcher could not express:
 *   - {scheduling-api, sessions-api} → +iam-api +programs-api, union of DBs +
 *     mesh (postgres + rabbitmq, mongo dropped — no connect-api).
 *   - saga-dash → 8 services (NOT the full 10/11) — no connect-api/connect-web/rtsm-api.
 *   - connect-web → pulls content-api (via connect-api), connectv3 DB + connect-mongo mesh.
 *   - unknown id throws.
 *
 * PURE: no docker/pnpm/network.
 */

import { describe, expect, it } from 'vitest';
import { computeClosure } from '../closure.js';
import { launchOrder } from '../launch-order.js';
import { manifest } from '../manifest/index.js';
import type { ServiceId } from '../manifest/index.js';

describe('computeClosure — {scheduling-api, sessions-api}', () => {
  const closure = computeClosure(manifest, ['scheduling-api', 'sessions-api']);

  it('pulls in iam-api + programs-api, topo-ordered', () => {
    expect(closure.services).toEqual([
      'iam-api',
      'programs-api',
      'scheduling-api',
      'sessions-api',
    ]);
  });

  it('unions the closure databases in manifest declaration order', () => {
    expect(closure.databases).toEqual([
      'iam_local',
      'iam_pii_local',
      'programs',
      'scheduling',
      'sessions',
    ]);
  });

  it('unions the mesh to {postgres, redis, rabbitmq} — mongo dropped (no connect-api)', () => {
    // redis comes in via iam-api (its sole consumer); ordered by mesh declaration.
    expect(closure.mesh).toEqual(['postgres', 'redis', 'rabbitmq']);
    expect(closure.mesh).not.toContain('connect-mongo');
  });

  it('records WHY each service is present', () => {
    expect(closure.reasons.get('sessions-api')).toContain('requested');
    expect(closure.reasons.get('scheduling-api')).toContain('requested');
    // iam-api is a pure dependency — every reason is a "required by …" edge.
    const iamReasons = closure.reasons.get('iam-api') ?? [];
    expect(iamReasons).toContain('required by scheduling-api (url)');
    expect(iamReasons.every((r) => r.startsWith('required by'))).toBe(true);
    // programs-api is dragged in only as sessions-api's event dependency.
    expect(closure.reasons.get('programs-api')).toContain('required by sessions-api (event)');
    expect(closure.reasons.get('programs-api')).not.toContain('requested');
  });
});

describe('computeClosure — saga-dash', () => {
  const closure = computeClosure(manifest, ['saga-dash']);

  it('resolves to 8 services (NOT the full stack)', () => {
    expect(closure.services).toHaveLength(8);
    expect(new Set(closure.services)).toEqual(
      new Set<ServiceId>([
        'iam-api',
        'sis-api',
        'programs-api',
        'scheduling-api',
        'sessions-api',
        'content-api',
        'ads-adm-api',
        'saga-dash',
      ]),
    );
  });

  it('does NOT pull connect-api / connect-web / rtsm-api (no edge from the dash closure)', () => {
    expect(closure.services).not.toContain('connect-api');
    expect(closure.services).not.toContain('connect-web');
    expect(closure.services).not.toContain('rtsm-api');
  });

  it('does NOT pull optional playback services', () => {
    expect(closure.services).not.toContain('transcripts-api');
    expect(closure.services).not.toContain('insights-api');
    expect(closure.services).not.toContain('chat-api');
  });

  it('launches iam-api first (every dash dependency needs it)', () => {
    expect(closure.services[0]).toBe('iam-api');
  });
});

describe('computeClosure — connect-web pulls content-api', () => {
  const closure = computeClosure(manifest, ['connect-web']);

  it('includes content-api via connect-api (§2.3 fix)', () => {
    expect(closure.services).toContain('content-api');
    expect(closure.reasons.get('content-api')).toContain('required by connect-api (url)');
  });

  it('includes the rest of the connect closure', () => {
    for (const id of ['connect-web', 'connect-api', 'rtsm-api', 'iam-api', 'sessions-api'] as const) {
      expect(closure.services).toContain(id);
    }
  });

  it('pulls the connectv3 mongo DB + connect-mongo mesh', () => {
    expect(closure.databases).toContain('connectv3');
    expect(closure.databases).toContain('content');
    expect(closure.mesh).toContain('connect-mongo');
  });
});

describe('computeClosure — playback gate', () => {
  it('drops an optional playback service unless --with-playback', () => {
    const closure = computeClosure(manifest, ['transcripts-api']);
    expect(closure.services).not.toContain('transcripts-api');
    expect(closure.services).toHaveLength(0);
  });

  it('keeps it when withPlayback is set', () => {
    const closure = computeClosure(manifest, ['transcripts-api'], { withPlayback: true });
    expect(closure.services).toContain('transcripts-api');
  });
});

describe('computeClosure — bad input', () => {
  it('throws on an unknown requested service id', () => {
    expect(() => computeClosure(manifest, ['nope' as ServiceId])).toThrow(/unknown service id/);
  });
});

describe('launchOrder — Kahn waves', () => {
  it('orders a partial set into dependency waves (deps before dependents)', () => {
    const waves = launchOrder(
      ['sessions-api', 'scheduling-api', 'programs-api', 'iam-api'],
      manifest,
    );
    expect(waves[0]).toEqual(['iam-api']); // wave 1: no in-set deps
    expect(waves[1]).toEqual(['programs-api', 'scheduling-api']); // declaration-stable
    expect(waves[2]).toEqual(['sessions-api']); // depends on programs + scheduling
  });

  it('ignores edges to services outside the supplied set', () => {
    // sessions-api alone has no in-set deps → a single wave.
    expect(launchOrder(['sessions-api'], manifest)).toEqual([['sessions-api']]);
  });

  it('throws on an unknown id', () => {
    expect(() => launchOrder(['nope' as ServiceId], manifest)).toThrow(/unknown service id/);
  });
});
