/**
 * frontend-variant — pure helpers for the multi-frontend feature (`ss frontend`).
 *
 * A "variant" is an extra saga-dash dev server (from a caller-supplied checkout)
 * launched against a running stack. This module owns the PURE decisions: parsing
 * the `<label>=<path>` arg, the pidfile id namespacing, and port selection. No IO
 * (`src/core/**` never imports `src/runtime/**`); the command layer supplies the
 * checkout path, runs the launcher, and probes ports.
 */

import { SLOT_PORT_STRIDE, deriveInstance } from './derive-instance.js';
import { manifest as defaultManifest, type Manifest, type ServiceId } from './manifest/index.js';

/** Pidfile-id prefix: a variant is tracked as `saga-dash@<label>` so `stack down`
 *  reaps it like any service while staying distinct from the primary `saga-dash`. */
export const FRONTEND_ID_PREFIX = 'saga-dash@';

/** Max variants per slot — well beyond real use; guards a runaway registry. */
export const MAX_VARIANTS_PER_SLOT = 9;

/** The pidfile/service id for a variant label. */
export function frontendServiceId(label: string): string {
  return `${FRONTEND_ID_PREFIX}${label}`;
}

const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Parse a `<label>=<path>` arg. Splits on the FIRST `=` (a path may contain `=`).
 * The label must be a bare slug (it becomes a pidfile name + a browser tab key).
 * Throws a user-facing Error on any malformed input.
 */
export function parseVariantArg(raw: string): { label: string; path: string } {
  const eq = raw.indexOf('=');
  if (eq < 0) {
    throw new Error(`expected label=path, got "${raw}"`);
  }
  const label = raw.slice(0, eq).trim();
  const path = raw.slice(eq + 1).trim();
  if (!LABEL_RE.test(label)) {
    throw new Error(
      `invalid label "${label}" — use letters/digits/_/- (starts alnum), e.g. main=/path/to/saga-dash`,
    );
  }
  if (path === '') {
    throw new Error(`empty path in "${raw}" — expected label=path`);
  }
  return { label, path };
}

/**
 * Every resolved service port across all slots (0..9). Used to keep an
 * auto-assigned variant port from ever colliding with a stack service — including
 * one that is not up yet but could be brought up later.
 */
export function reservedServicePorts(m: Manifest = defaultManifest): Set<number> {
  const ports = new Set<number>();
  for (let slot = 0; slot <= 9; slot++) {
    const { portOverrides } = deriveInstance({ slot }, m);
    for (const p of Object.values(portOverrides)) {
      if (typeof p === 'number') ports.add(p);
    }
  }
  return ports;
}

/**
 * Ordered candidate ports for a variant at a slot whose dash base is `dashBase`:
 * `dashBase+1 …` up to (but not into) the next slot's band, excluding any
 * `reserved` stack service port and any `occupied` (already-registered) port. The
 * caller probes these in order for the first not-listening one.
 */
export function variantPortCandidates(
  dashBase: number,
  reserved: Set<number>,
  occupied: Set<number>,
): number[] {
  const out: number[] = [];
  for (let p = dashBase + 1; p < dashBase + SLOT_PORT_STRIDE; p++) {
    if (reserved.has(p) || occupied.has(p)) continue;
    out.push(p);
  }
  return out;
}

/** argv for `pnpm dev --port <port>` (no `--` separator, so vite honours it). */
export function variantLaunchArgs(port: number): string[] {
  return ['dev', '--port', String(port)];
}

/** The health URL a variant is polled at (saga-dash healthPath is `/`). */
export function variantHealthUrl(port: number): string {
  return `http://localhost:${port}/`;
}

// `ServiceId` re-exported for the command layer's manifest env lookup.
export type { ServiceId };
