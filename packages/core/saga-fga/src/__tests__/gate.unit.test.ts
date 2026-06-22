import { describe, it, expect } from 'vitest';
import { loadFgaGateConfig, enforceFgaRelation, type FgaGate } from '../index.js';

describe('saga-fga gate config', () => {
  it('defaults enforcement OFF', () => {
    expect(loadFgaGateConfig({}).enforce).toBe(false);
  });

  it('enables enforcement only on the exact string "true"', () => {
    expect(loadFgaGateConfig({ AUTHZ_FGA_ENFORCE: 'true' }).enforce).toBe(true);
    expect(loadFgaGateConfig({ AUTHZ_FGA_ENFORCE: '1' }).enforce).toBe(false);
    expect(loadFgaGateConfig({ AUTHZ_FGA_ENFORCE: 'TRUE' }).enforce).toBe(false);
  });

  it('reads endpoint + store/model from env, with a localhost default', () => {
    const c = loadFgaGateConfig({ OPENFGA_STORE_ID: 's1', OPENFGA_MODEL_ID: 'm1' });
    expect(c.apiUrl).toBe('http://localhost:8080');
    expect(c.storeId).toBe('s1');
    expect(c.modelId).toBe('m1');
  });
});

describe('enforceFgaRelation', () => {
  it('is a no-op when the gate is disabled — never calls check', async () => {
    let called = false;
    const gate: FgaGate = { enforce: false, async check() { called = true; return false; } };
    await enforceFgaRelation(gate, 'user:a', 'host', 'session:s', () => new Error('should not throw'));
    expect(called).toBe(false);
  });

  it('throws makeForbidden() when the relation does not hold', async () => {
    const gate: FgaGate = { enforce: true, async check() { return false; } };
    await expect(
      enforceFgaRelation(gate, 'user:a', 'host', 'session:s', () => new Error('forbidden')),
    ).rejects.toThrow('forbidden');
  });

  it('passes (resolves) when the relation holds', async () => {
    let asked: [string, string, string] | undefined;
    const gate: FgaGate = {
      enforce: true,
      async check(u, r, o) { asked = [u, r, o]; return true; },
    };
    await expect(
      enforceFgaRelation(gate, 'user:a', 'host', 'session:s', () => new Error('forbidden')),
    ).resolves.toBeUndefined();
    expect(asked).toEqual(['user:a', 'host', 'session:s']);
  });
});
