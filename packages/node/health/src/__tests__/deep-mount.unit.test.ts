import { describe, expect, it } from 'vitest';
import { readinessReportJsonSchema } from '../schema.js';
import {
  createBearerAuthorizer,
  createDeepReadiness,
  declareDependencies,
  dep,
  mountDeepReadiness,
  type ReadinessReport,
} from '../index.js';

function fakeApp() {
  const routes = new Map<string, (req: unknown, res: unknown) => unknown>();
  const app = { get: (p: string, h: (req: unknown, res: never) => unknown) => void routes.set(p, h as never) };
  async function call(path: string, headers: Record<string, string> = {}) {
    let code = 200;
    let body: unknown;
    const res = {
      status(c: number) {
        code = c;
        return res;
      },
      json(b: unknown) {
        body = b;
      },
    };
    await routes.get(path)!({ headers }, res);
    return { code, body: body as Record<string, unknown> };
  }
  return { app, call };
}

const make = (token?: string) =>
  createDeepReadiness({
    manifest: declareDependencies({
      service: 'svc',
      dependencies: [dep({ name: 'db', kind: 'custom', criticality: 'critical', scope: 'shared', client: () => 1, probe: async () => undefined })],
    }),
    env: 'prod',
    minProbeGapMs: 0,
    authorizeInternal: createBearerAuthorizer(() => token),
  });

describe('mountDeepReadiness', () => {
  it('/live is 200 always; /ready 503 starting then 200; /deep probes', async () => {
    const { app, call } = fakeApp();
    const dr = make();
    mountDeepReadiness(app, dr);
    expect((await call('/health/live')).code).toBe(200);
    expect((await call('/health/ready')).code).toBe(503);
    await dr.boot();
    expect((await call('/health/ready')).code).toBe(200);
    expect((await call('/health/deep')).body.verdict).toBe('ready');
  });

  it('public by default; internal only with the right bearer; wrong/missing/unset token denied', async () => {
    const { app, call } = fakeApp();
    const dr = make('s3cret-token');
    mountDeepReadiness(app, dr);
    await dr.boot();
    expect((await call('/health/ready')).body.dependencies).toBeUndefined();
    expect((await call('/health/ready', { authorization: 'Bearer nope' })).body.dependencies).toBeUndefined();
    expect((await call('/health/ready', { authorization: 's3cret-token' })).body.dependencies).toBeUndefined();
    const ok = await call('/health/ready', { authorization: 'Bearer s3cret-token' });
    expect(ok.body.dependencies).toHaveLength(1);
    expect(ok.body.checks).toBeDefined();
    expect((await call('/health/deep', { authorization: 'bearer s3cret-token' })).body.dependencies).toHaveLength(1);

    const unset = fakeApp();
    const dr2 = make(undefined);
    mountDeepReadiness(unset.app, dr2);
    await dr2.boot();
    expect((await unset.call('/health/ready', { authorization: 'Bearer ' })).body.dependencies).toBeUndefined();
  });

  it('reports conform to the exported JSON Schema (required keys, enums)', async () => {
    const { app, call } = fakeApp();
    const dr = make('t');
    mountDeepReadiness(app, dr);
    await dr.boot();
    const rep = (await call('/health/deep', { authorization: 'Bearer t' })).body as unknown as ReadinessReport;
    const s = readinessReportJsonSchema;
    for (const k of s.required) expect(rep).toHaveProperty(k);
    expect(s.properties.verdict.enum).toContain(rep.verdict);
    expect(s.properties.bootMode.enum).toContain(rep.bootMode);
    expect(s.properties.schema.const).toBe(rep.schema);
    const d = rep.dependencies![0]!;
    for (const k of s.properties.dependencies.items.required) expect(d).toHaveProperty(k);
    expect(s.properties.dependencies.items.properties.state.enum).toContain(d.state);
    for (const k of Object.keys(rep)) expect(Object.keys(s.properties)).toContain(k);
  });
});
