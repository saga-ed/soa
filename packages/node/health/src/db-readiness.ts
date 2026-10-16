import { TIMEOUT, withTimeout, type ProbeResult } from './readiness.js';

export interface DbReadinessOptions {
  /** Cheap DB round-trip (e.g. `SELECT 1`); must reject on failure. */
  ping: () => Promise<unknown>;
  /** Background ping cadence (default 15000). */
  intervalMs?: number;
  /** Not-ready once no success has been recorded for longer than this (default 300000). */
  staleAfterMs?: number;
  /** Per-ping hard timeout (default 2000); a timeout counts as a failure. */
  timeoutMs?: number;
  now?: () => number;
}

export interface DbReadinessSnapshot {
  state: 'starting' | 'connected' | 'stale';
  lastSuccessAt: number | undefined;
  msSinceSuccess: number | undefined;
  lastErrorClass: string | undefined;
}

export interface DbReadiness {
  start(): void;
  stop(): void;
  /** Record a successful query made by real traffic; suppresses background pings for `intervalMs`. */
  markSuccess(): void;
  /** Reads state only; never touches the DB. Usable as a `mountReadinessRoutes` probe. */
  probe: () => Promise<ProbeResult>;
  snapshot(): DbReadinessSnapshot;
}

function errorClass(err: unknown): string {
  if (err === TIMEOUT) return 'Timeout';
  if (err instanceof Error) return err.constructor?.name || err.name || 'Error';
  return typeof err;
}

export function createDbReadiness(opts: DbReadinessOptions): DbReadiness {
  const intervalMs = opts.intervalMs ?? 15000;
  const staleAfterMs = opts.staleAfterMs ?? 300000;
  const timeoutMs = opts.timeoutMs ?? 2000;
  const now = opts.now ?? Date.now;

  let lastSuccessAt: number | undefined;
  let lastErrorClass: string | undefined;
  let inFlight = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const markSuccess = (): void => {
    lastSuccessAt = now();
    lastErrorClass = undefined;
  };

  // inFlight is held until the ping settles or times out, so pings never overlap.
  async function tick(): Promise<void> {
    if (inFlight) return;
    if (lastSuccessAt !== undefined && now() - lastSuccessAt < intervalMs) return;
    inFlight = true;
    try {
      await withTimeout(Promise.resolve().then(opts.ping), timeoutMs);
      markSuccess();
    } catch (err) {
      lastErrorClass = errorClass(err);
    } finally {
      inFlight = false;
    }
  }

  function state(): DbReadinessSnapshot['state'] {
    if (lastSuccessAt === undefined) return 'starting';
    return now() - lastSuccessAt > staleAfterMs ? 'stale' : 'connected';
  }

  return {
    start() {
      if (timer) return;
      void tick();
      timer = setInterval(() => void tick(), intervalMs);
      (timer as { unref?: () => void }).unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    markSuccess,
    probe: async () => {
      const s = state();
      return { ready: s === 'connected', detail: s };
    },
    snapshot: () => ({
      state: state(),
      lastSuccessAt,
      msSinceSuccess: lastSuccessAt === undefined ? undefined : now() - lastSuccessAt,
      lastErrorClass,
    }),
  };
}
