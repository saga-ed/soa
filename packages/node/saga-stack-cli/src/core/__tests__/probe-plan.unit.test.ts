/**
 * probe-plan unit tests (plan §2.4, §7.2 "M2 — native status/verify").
 *
 * `healthProbes` is the PURE, manifest-derived probe list that native
 * `stack status` / `stack verify` probe. The headline assertion is the GAP
 * CLOSURE: content-api `:3009/health` is present — the endpoint the
 * hand-maintained verify.sh list missed. PURE: no IO, no network, no spawn.
 */

import { describe, expect, it } from 'vitest';
import { healthProbes } from '../probe-plan.js';
import { manifest } from '../manifest/index.js';
import type { ServiceId } from '../manifest/index.js';

describe('healthProbes — manifest-derived probe list', () => {
  it('CLOSES THE GAP: content-api :3009/health is in the default probe set', () => {
    const probes = healthProbes(manifest);
    const content = probes.find((p) => p.id === 'content-api');
    expect(content).toBeDefined();
    expect(content).toEqual({
      id: 'content-api',
      url: 'http://localhost:3009/health',
      healthPath: '/health',
      expectStatus: 200,
    });
  });

  it('builds each url from the STACK lane + healthPath (incl. nested + root paths)', () => {
    const by = Object.fromEntries(healthProbes(manifest).map((p) => [p.id, p.url]));
    expect(by['iam-api']).toBe('http://localhost:3010/health');
    expect(by['sis-api']).toBe('http://localhost:3100/health');
    // connect-api's health path is nested, not /health.
    expect(by['connect-api']).toBe('http://localhost:6106/connectv3/v1/health');
    // frontends probe the root path '/'.
    expect(by['saga-dash']).toBe('http://localhost:8900/');
    expect(by['connect-web']).toBe('http://localhost:6210/');
  });

  it('default set = every NON-optional service, in manifest declaration order', () => {
    const probes = healthProbes(manifest);
    const ids = probes.map((p) => p.id);
    // 11 non-optional (10 core + rtsm-api); the 3 playback APIs are excluded.
    expect(ids).toHaveLength(11);
    expect(ids).not.toContain('transcripts-api');
    expect(ids).not.toContain('insights-api');
    expect(ids).not.toContain('chat-api');
    // declaration order: iam-api leads, rtsm-api trails the non-optional block.
    expect(ids[0]).toBe('iam-api');
    expect(ids).toContain('content-api');
  });

  it('an explicit service subset is probed in the order supplied', () => {
    const subset: ServiceId[] = ['sessions-api', 'iam-api', 'content-api'];
    const ids = healthProbes(manifest, subset).map((p) => p.id);
    expect(ids).toEqual(['sessions-api', 'iam-api', 'content-api']);
  });

  it('an explicit subset MAY include optional playback services', () => {
    const ids = healthProbes(manifest, ['transcripts-api']).map((p) => p.id);
    expect(ids).toEqual(['transcripts-api']);
  });

  it('throws on an unknown service id', () => {
    expect(() => healthProbes(manifest, ['nope' as ServiceId])).toThrow(/unknown service id/);
  });
});
