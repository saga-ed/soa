import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as api from '../index.js';

// 0.1.x sources are frozen so 0.1.x consumers can move to 0.2.x without a behaviour change. Any edit must be a deliberate, reviewed change.
// health.ts, readiness.ts: pinned at 0.3.0 (additive identity option); the body-shape test guards 0.1.x output.
const FROZEN: Record<string, string> = {
  'db-boot.ts': 'd69fe53e7843dfe9db9cc35b5383d32e3393fa8c0a2fcf006f028959c5e3e80d',
  'db-readiness.ts': 'ba4f00823e148a0d0cb310b1b13bb003d4e92ce840ea36c67bc0cc488739d5e0',
  'drain.ts': '5278a1cc9aabba802c1de158a114c9e44db285d3633d2cd200b9f1c192de1c45',
  'health.ts': '63a021c3d696495a6516bcfcf750277fcb8cefec351bc5f38d7147f206be94df',
  'readiness.ts': 'a46658c8822b5149d072f286c8bd4657caed8c33ea861399ba47604efaf8f92c',
};

describe('0.1.x compatibility pin', () => {
  it.each(Object.entries(FROZEN))('%s matches its pinned hash', (file, sha) => {
    const bytes = readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(sha);
  });

  it('still exports every 0.1.x runtime export', () => {
    for (const name of [
      'mountHealthRoutes',
      'buildIdentity',
      'mountReadinessRoutes',
      'createDbReadiness',
      'awaitDbAtBoot',
      'createDrainSignal',
    ]) {
      expect(typeof (api as Record<string, unknown>)[name]).toBe('function');
    }
  });

  it('0.1.x readiness bodies are unchanged', async () => {
    const routes = new Map<string, (req: unknown, res: unknown) => Promise<void> | void>();
    api.mountReadinessRoutes(
      { get: (p, h) => void routes.set(p, h as never) },
      { probes: { db: async () => ({ ready: false, detail: 'starting' }) } },
    );
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
    await routes.get('/health/ready')!({}, res);
    expect(code).toBe(503);
    expect(body).toEqual({ status: 'not ready', checks: { db: { ready: false, detail: 'starting' } } });
  });
});
