import { describe, expect, it } from 'vitest';
import {
  FRONTEND_ID_PREFIX,
  MAX_VARIANTS_PER_SLOT,
  frontendServiceId,
  parseVariantArg,
  reservedServicePorts,
  variantHealthUrl,
  variantLaunchArgs,
  variantPortCandidates,
} from '../frontend-variant.js';

describe('frontend-variant (pure)', () => {
  it('parseVariantArg splits on the FIRST = and validates the label', () => {
    expect(parseVariantArg('main=/home/me/saga-dash')).toEqual({
      label: 'main',
      path: '/home/me/saga-dash',
    });
    // a path may itself contain '=' — only the first splits.
    expect(parseVariantArg('x=/tmp/a=b')).toEqual({ label: 'x', path: '/tmp/a=b' });
  });

  it('parseVariantArg rejects malformed input', () => {
    expect(() => parseVariantArg('no-equals')).toThrow(/label=path/);
    expect(() => parseVariantArg('=/tmp/x')).toThrow(/label/);
    expect(() => parseVariantArg('main=')).toThrow(/path/);
    expect(() => parseVariantArg('bad label=/tmp/x')).toThrow(/label/);
  });

  it('frontendServiceId namespaces the pidfile id under the saga-dash service', () => {
    expect(frontendServiceId('main')).toBe('saga-dash@main');
    expect(FRONTEND_ID_PREFIX).toBe('saga-dash@');
  });

  it('reservedServicePorts includes every slot dash port (8900, 9900, …)', () => {
    const reserved = reservedServicePorts();
    expect(reserved.has(8900)).toBe(true); // slot 0 dash
    expect(reserved.has(9900)).toBe(true); // slot 1 dash
    expect(reserved.has(3010)).toBe(true); // slot 0 iam
  });

  it('variantPortCandidates yields in-band free ports above the dash base', () => {
    const reserved = reservedServicePorts();
    const cands = variantPortCandidates(8900, reserved, new Set([8901]));
    expect(cands[0]).toBe(8902); // 8901 occupied, 8900 excluded (base), 8900 reserved
    expect(cands.every((p) => p > 8900 && p < 8900 + 1000)).toBe(true);
    expect(cands.includes(9900)).toBe(false); // next slot's dash is reserved
  });

  it('variantLaunchArgs / variantHealthUrl build the pnpm-dev launch', () => {
    expect(variantLaunchArgs(8902)).toEqual(['dev', '--port', '8902']);
    expect(variantHealthUrl(8902)).toBe('http://localhost:8902/');
    expect(MAX_VARIANTS_PER_SLOT).toBe(9);
  });
});
