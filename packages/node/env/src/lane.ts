import type { LaneParse, Vars } from './types.js';

/** Pure. Strict on LANE alone (no EXEC_ENV alias; that shim stays in lane-guard). Never throws. */
export function parseLane(vars: Vars): LaneParse {
  const raw = vars['LANE'];
  if (raw === undefined) return { lane: 'none' };
  const value = raw.trim().toLowerCase();
  if (value === '' || value === 'none') return { lane: 'none' };
  if (value === 'twin' || value === 'mirror') return { lane: value };
  return { lane: 'invalid', reason: 'LANE must be one of twin, mirror, none (or unset)' };
}
