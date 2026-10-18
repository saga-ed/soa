import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as api from '../index.js';

// 0.1.x sources are frozen so 0.1.x consumers can move to 0.2.x without a behaviour change. Any edit must be a deliberate, reviewed change.
const FROZEN: Record<string, string> = {
  'db-boot.ts': 'd69fe53e7843dfe9db9cc35b5383d32e3393fa8c0a2fcf006f028959c5e3e80d',
  'db-readiness.ts': 'ba4f00823e148a0d0cb310b1b13bb003d4e92ce840ea36c67bc0cc488739d5e0',
  'drain.ts': '5278a1cc9aabba802c1de158a114c9e44db285d3633d2cd200b9f1c192de1c45',
  'health.ts': '4eeb0a4aeea757ad4fdd63a3a6cfd517973308d427daa97a5f5e6e8636a0fba2',
  'readiness.ts': '1599cba6905cc2c45988fa18af38c5f4747f4ce7f5776d686f8bc72a5663a97b',
};

describe('0.1.x compatibility pin', () => {
  it.each(Object.entries(FROZEN))('%s is byte-identical to 0.1.1', (file, sha) => {
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
