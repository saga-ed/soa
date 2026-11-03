import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { channel } from 'node:diagnostics_channel';
import { diag, type Meter } from '@opentelemetry/api';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'tsup';
import { createHttpClientMetrics, resolveHttpMetricPeers } from './http-client-metrics.js';
import { resolveMetricExportInterval } from './tracing.js';

const peer = {
  service: 'iam-api',
  origins: ['http://localhost:6010'],
  routes: [{ path: '/trpc/personas.getMyPermissions', methods: ['GET'] }],
};

describe('HTTP metrics opt-in guardrails', () => {
  it('accepts bounded exact origins and declared route templates only', () => {
    expect(resolveHttpMetricPeers(JSON.stringify([peer]))).toEqual([peer]);
    for (const invalid of [
      null,
      {},
      [],
      [{ ...peer, service: 'http://private' }],
      [{ ...peer, origins: ['https://user:secret@host'] }],
      [{ ...peer, origins: ['https://host/path'] }],
      [{ ...peer, routes: [{ path: '/people?secret=value', methods: ['GET'] }] }],
      [{ ...peer, routes: [{ path: '/people/*', methods: ['GET'] }] }],
      [{ ...peer, routes: [{ path: '/people/:id', methods: ['ARBITRARY'] }] }],
      Array.from({ length: 17 }, () => peer),
      [{ ...peer, routes: [peer.routes[0], peer.routes[0]] }],
    ]) {
      expect(resolveHttpMetricPeers(JSON.stringify(invalid))).toBeUndefined();
    }
    expect(resolveHttpMetricPeers('{')).toBeUndefined();
  });
  it('bounds the export interval without crashing service startup', () => {
    expect(resolveMetricExportInterval('10000')).toBe(10000);
    for (const value of ['NaN', '0', '999', '60001'])
      expect(resolveMetricExportInterval(value)).toBe(60000);
  });
  it('rejects route aliases that would collide in matching or Datadog tag normalization', () => {
    for (const paths of [
      ['/people/:id', '/people/:other'],
      ['/people/getById', '/people/getbyid'],
    ]) {
      expect(
        resolveHttpMetricPeers(
          JSON.stringify([{ ...peer, routes: paths.map(path => ({ path, methods: ['GET'] })) }])
        )
      ).toBeUndefined();
    }
  });
  it('isolates malformed diagnostics from application execution and removes subscriptions on shutdown', () => {
    const before = channel('undici:request:create').hasSubscribers;
    const warn = vi.spyOn(diag, 'warn').mockImplementation(() => {});
    const remove = vi.fn();
    const heartbeat = {};
    let collect!: Parameters<Meter['addBatchObservableCallback']>[0];
    const meter = {
      createObservableCounter: () => ({}),
      createObservableGauge: () => heartbeat,
      addBatchObservableCallback: (callback: typeof collect) => {
        collect = callback;
      },
      removeBatchObservableCallback: remove,
    } as unknown as Meter;
    const observer = createHttpClientMetrics('programs-api', [peer], meter);
    try {
      expect(() => channel('undici:request:create').publish({})).not.toThrow();
      expect(() => channel('undici:request:create').publish({})).not.toThrow();
      expect(warn).toHaveBeenCalledTimes(1);
      const observe = vi.fn();
      collect({ observe });
      expect(observe).toHaveBeenCalledWith(heartbeat, 0, expect.any(Object));
    } finally {
      observer.close();
      warn.mockRestore();
    }
    expect(remove).toHaveBeenCalledTimes(1);
    expect(channel('undici:request:create').hasSubscribers).toBe(before);
  });
});

type Metric = {
  name: string;
  resource: Record<string, string>;
  temporality?: number;
  points: { attributes: Record<string, string>; value: number }[];
};
describe('real HTTP counters with all spans unsampled', () => {
  let folder: string;
  let result: { traceExports: number; exports: Metric[][] };
  beforeAll(async () => {
    const cache = resolve('node_modules/.cache');
    await mkdir(cache, { recursive: true });
    folder = await mkdtemp(resolve(cache, 'http-client-metrics-'));
    await build({
      entry: ['src/index.ts'],
      outDir: folder,
      format: ['esm'],
      dts: false,
      sourcemap: false,
      config: false,
      silent: true,
    });
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        resolve('src/__tests__/fixtures/http-client-metrics-child.mjs'),
        resolve(folder, 'index.js'),
      ],
      { timeout: 25000, maxBuffer: 1024 * 1024 }
    );
    result = JSON.parse(stdout.trim().split('\n').at(-1)!);
  }, 40000);
  afterAll(async () => {
    if (folder) await rm(folder, { recursive: true });
  });
  const points = (name: string) =>
    result.exports.flatMap(batch =>
      batch.filter(metric => metric.name === name).flatMap(metric => metric.points)
    );
  it('counts each physical attempt once despite concurrency, retries, errors, aborts and duplicate lifecycle events', () => {
    expect(result.traceExports).toBe(0);
    expect(points('saga.http.client.attempts').reduce((sum, point) => sum + point.value, 0)).toBe(
      22
    );
    expect(points('saga.http.client.requests').reduce((sum, point) => sum + point.value, 0)).toBe(
      22
    );
    const outcomes: Record<string, number> = {};
    for (const point of points('saga.http.client.requests'))
      outcomes[point.attributes.outcome] = (outcomes[point.attributes.outcome] ?? 0) + point.value;
    expect(outcomes).toEqual({ success: 16, http_error: 1, transport_error: 3, aborted: 2 });
  });
  it('emits explicit idle zero deltas and a per-path heartbeat', () => {
    const batches = result.exports.filter(batch =>
      batch.some(metric => metric.name === 'saga.http.client.requests')
    );
    expect(batches.length).toBeGreaterThanOrEqual(3);
    for (const batch of [batches[0], batches.at(-1)!]) {
      expect(
        batch
          .find(metric => metric.name === 'saga.http.client.requests')!
          .points.every(point => point.value === 0)
      ).toBe(true);
      expect(
        batch
          .find(metric => metric.name === 'saga.http.client.metrics.active')!
          .points.every(point => point.value === 1)
      ).toBe(true);
    }
    expect(points('saga.http.client.requests').some(point => point.value > 0)).toBe(true);
    expect(
      batches
        .flatMap(batch => batch.filter(metric => metric.name === 'saga.http.client.requests'))
        .every(metric => metric.temporality === 1)
    ).toBe(true);
  });
  it('exports only declared peer/routes and exact resource scope, never request identifiers or query strings', () => {
    for (const metric of result.exports.flat()) {
      expect(metric.resource).toMatchObject({
        'service.name': 'programs-api',
        'deployment.environment.name': 'synthetic',
        'deployment.identifier': 'slot-3',
        'synthetic.machine': 'telemetry-test',
      });
      for (const point of metric.points) {
        expect(point.attributes).toMatchObject({
          'source.service': 'programs-api',
          'peer.service': 'iam-api',
          'http.method': 'GET',
        });
        expect(['/trpc/personas.getMyPermissions', '/people/:id']).toContain(
          point.attributes['http.route']
        );
      }
    }
    expect(JSON.stringify(result)).not.toMatch(
      /student-id|12345|another-private-value|unlisted|private=|secret=/
    );
  });
});
