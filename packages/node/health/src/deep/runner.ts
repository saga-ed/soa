import { buildIdentity } from '../health.js';
import { withTimeout } from '../readiness.js';
import { defaultProbe } from './adapters.js';
import { classifyError } from './classify.js';
import { asDecl, type Decl } from './manifest.js';
import type {
  BootMode,
  CreateDeepReadinessOptions,
  DeepReadiness,
  DependencyReport,
  DependencyState,
  DetailLevel,
  ProbeOutcome,
  ProbeReason,
  ReadinessReport,
  ReadinessVerdict,
} from './types.js';

interface Rt {
  d: Decl;
  hasSucceeded: boolean;
  skipped: boolean;
  lastSuccessAt?: number;
  lastAttemptAt?: number;
  lastRefreshAt?: number;
  trafficOkAt?: number;
  consecutiveFailures: number;
  neutral: boolean;
  lastReason?: ProbeReason;
  latencyMs?: number;
  schemaFailed?: ProbeReason;
  deepProbed: boolean;
  inFlight?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
}

interface Snapshot {
  verdict: ReadinessVerdict;
  deps: DependencyReport[];
  at: number;
}

const ambientEnv = (): Record<string, string | undefined> =>
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

/** Unknown/unset value => 'block' (fail closed). */
export function parseBootMode(v: string | undefined): BootMode {
  return v === 'warn' || v === 'open' ? v : 'block';
}

const scopeOf = (d: Decl): 'task' | 'shared' | undefined => (d.criticality === 'critical' ? d.scope : undefined);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function createDeepReadiness(opts: CreateDeepReadinessOptions): DeepReadiness {
  const env = ambientEnv();
  const localLike = opts.identity?.account.kind === 'local';
  const bootMode: BootMode = opts.bootMode ?? parseBootMode(env.READINESS_BOOT);
  const now = opts.now ?? Date.now;
  const intervalMs = opts.intervalMs ?? 15000;
  const timeoutMs = opts.timeoutMs ?? 2000;
  const bootTimeoutMs = opts.bootTimeoutMs ?? 60000;
  const bootRetryDelayMs = opts.bootRetryDelayMs ?? 2000;
  const minProbeGapMs = opts.minProbeGapMs ?? 1000;
  const deepCacheMs = opts.deepCacheMs ?? 5000;
  const staleAfterMs = opts.staleAfterMs ?? 60000;
  const service = opts.manifest.service;

  const rts: Rt[] = opts.manifest.dependencies.map((raw) => ({
    d: asDecl(raw),
    hasSucceeded: false,
    skipped: false,
    consecutiveFailures: 0,
    neutral: false,
    deepProbed: false,
  }));
  const byName = new Map(rts.map((r) => [r.d.name, r]));
  let startedAt: number | undefined;
  let started = false;
  let lastVerdict: ReadinessVerdict | undefined;
  let deepCache: Snapshot | undefined;
  let deepInFlight: Promise<Snapshot> | undefined;

  const threshold = (rt: Rt): number => rt.d.failureThreshold ?? 2;

  async function runProbeFn(
    rt: Rt,
    fn: (c: never, s: AbortSignal) => Promise<ProbeOutcome | void>,
    client: unknown,
  ): Promise<ProbeOutcome> {
    const ac = new AbortController();
    try {
      const out = await withTimeout(Promise.resolve().then(() => fn(client as never, ac.signal)), rt.d.timeoutMs ?? timeoutMs);
      return out && out.ok === false ? { ok: false, reason: out.reason ?? 'error' } : { ok: true };
    } catch (err) {
      ac.abort();
      opts.onProbeError?.(rt.d.name, err);
      return { ok: false, reason: classifyError(err) };
    }
  }

  async function run(rt: Rt, deep: boolean): Promise<void> {
    const t0 = now();
    const client = rt.d.client();
    let outcome: ProbeOutcome;
    if (client === null || client === undefined) {
      const absent = rt.d.whenAbsent ?? (localLike ? 'skipped' : 'fail');
      if (absent === 'skipped') {
        rt.skipped = true;
        rt.lastRefreshAt = now();
        return;
      }
      rt.skipped = false;
      outcome = { ok: false, reason: 'not_ready' };
    } else {
      rt.skipped = false;
      const fn = rt.d.probe ?? defaultProbe(rt.d);
      outcome = fn
        ? await runProbeFn(rt, fn, client)
        : { ok: false, reason: 'error' };
      if (outcome.ok && deep && rt.d.schemaProbe) {
        const s = await runProbeFn(rt, rt.d.schemaProbe, client);
        rt.schemaFailed = s.ok ? undefined : s.reason === 'error' || !s.reason ? 'schema' : s.reason;
      } else if (deep) {
        rt.schemaFailed = undefined;
      }
      if (deep) rt.deepProbed = true;
    }
    const t1 = now();
    rt.latencyMs = Math.max(0, Math.round(t1 - t0));
    rt.lastRefreshAt = t1;
    if (outcome.ok) {
      rt.hasSucceeded = true;
      rt.lastSuccessAt = t1;
      rt.consecutiveFailures = 0;
      rt.neutral = false;
      rt.lastReason = undefined;
    } else {
      const reason = outcome.reason ?? 'error';
      rt.lastReason = reason;
      opts.onEvent?.({ type: 'probe_failure', name: rt.d.name, reason });
      if (reason === 'pool_exhausted') rt.neutral = true;
      else {
        rt.neutral = false;
        rt.consecutiveFailures++;
      }
    }
  }

  function probeOnce(rt: Rt, deep: boolean, force: boolean): Promise<void> {
    if (rt.inFlight) return rt.inFlight;
    const t = now();
    if (!force && rt.lastAttemptAt !== undefined && t - rt.lastAttemptAt < minProbeGapMs) return Promise.resolve();
    rt.lastAttemptAt = t;
    rt.inFlight = run(rt, deep).finally(() => {
      rt.inFlight = undefined;
    });
    return rt.inFlight;
  }

  function stateOf(rt: Rt, t: number, deepMode: boolean): { state: DependencyState; reason?: ProbeReason } {
    if (rt.skipped) return { state: 'skipped' };
    const ref = rt.lastRefreshAt ?? startedAt;
    if (ref !== undefined && started && t - ref > staleAfterMs) return { state: 'stale' };
    if (deepMode && rt.hasSucceeded && rt.schemaFailed) return { state: 'failing', reason: rt.schemaFailed };
    if (!rt.hasSucceeded) {
      return rt.consecutiveFailures >= threshold(rt)
        ? { state: 'failing', reason: rt.lastReason }
        : { state: 'starting', reason: rt.lastReason };
    }
    if (rt.neutral) return { state: 'degraded', reason: rt.lastReason };
    if (rt.consecutiveFailures >= threshold(rt)) return { state: 'failing', reason: rt.lastReason };
    return { state: 'ok' };
  }

  function snapshot(deepMode: boolean): Snapshot {
    const t = now();
    const deps: DependencyReport[] = [];
    let notReady = false;
    let starting = false;
    let degraded = false;
    for (const rt of rts) {
      const { state, reason } = stateOf(rt, t, deepMode);
      const critical = rt.d.criticality === 'critical';
      const scope = scopeOf(rt.d);
      const taskScoped = critical && scope === 'task';
      if (state === 'stale') notReady = true;
      else if (state === 'skipped') {
        /* neutral */
      } else if (critical && !rt.hasSucceeded) {
        if (bootMode === 'open') degraded = true;
        else starting = true;
      } else if (state === 'failing') {
        const schemaHard = deepMode && critical && reason === 'schema' && rt.schemaFailed !== undefined;
        if (taskScoped || schemaHard) notReady = true;
        else degraded = true;
      } else if (state === 'degraded') degraded = true;
      else if (!critical && state === 'starting' && rt.lastReason) degraded = true;
      deps.push({
        name: rt.d.name,
        kind: rt.d.kind,
        criticality: rt.d.criticality,
        ...(scope ? { scope } : {}),
        state,
        ...(reason ? { reason } : {}),
        ...(rt.latencyMs !== undefined ? { latencyMs: rt.latencyMs } : {}),
        ...(rt.lastSuccessAt !== undefined ? { lastSuccessAgeMs: Math.max(0, t - rt.lastSuccessAt) } : {}),
        consecutiveFailures: rt.consecutiveFailures,
        level: deepMode && rt.deepProbed ? 'deep' : 'cached',
      });
    }
    const verdict: ReadinessVerdict = opts.isDraining?.()
      ? 'draining'
      : notReady
        ? 'not_ready'
        : starting
          ? 'starting'
          : degraded
            ? 'degraded'
            : 'ready';
    return { verdict, deps, at: t };
  }

  function render(snap: Snapshot, level: DetailLevel): ReadinessReport {
    const count = (c: 'critical' | 'optional') => {
      const mine = snap.deps.filter((d) => d.criticality === c);
      const ok = mine.filter((d) => d.state === 'ok' || d.state === 'skipped').length;
      return { ok, failing: mine.length - ok };
    };
    const report: ReadinessReport = {
      schema: 'saga.readiness/v1',
      service,
      verdict: snap.verdict,
      httpStatus: snap.verdict === 'ready' || snap.verdict === 'degraded' ? 200 : 503,
      build: buildIdentity(undefined, opts.identity),
      generatedAt: new Date(snap.at).toISOString(),
      bootMode,
      summary: { critical: count('critical'), optional: count('optional') },
    };
    if (level === 'internal') {
      report.dependencies = snap.deps;
      report.checks = Object.fromEntries(
        snap.deps.map((d) => [
          d.name,
          { ready: d.state === 'ok' || d.state === 'skipped', detail: d.reason ? `${d.state}:${d.reason}` : d.state },
        ]),
      );
    }
    if (lastVerdict !== snap.verdict) {
      opts.onEvent?.({ type: 'verdict', verdict: snap.verdict, ...(lastVerdict ? { previous: lastVerdict } : {}) });
      lastVerdict = snap.verdict;
    }
    return report;
  }

  function schedule(rt: Rt): void {
    const base = rt.d.intervalMs ?? intervalMs;
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));
    rt.timer = setTimeout(() => {
      if (!started) return;
      const suppressed = rt.trafficOkAt !== undefined && now() - rt.trafficOkAt < base;
      if (!suppressed) void probeOnce(rt, false, false);
      schedule(rt);
    }, delay);
    (rt.timer as { unref?: () => void }).unref?.();
  }

  const bootTargets = (): Array<{ rt: Rt; mode: 'block' | 'warn' }> =>
    rts.flatMap((rt) => {
      const m = rt.d.boot ?? (rt.d.criticality === 'critical' ? 'block' : 'skip');
      return m === 'skip' ? [] : [{ rt, mode: m }];
    });

  const done = (rt: Rt): boolean => rt.hasSucceeded || rt.skipped;

  return {
    bootMode,
    ...(opts.identity ? { identity: opts.identity } : {}),
    isDraining: () => opts.isDraining?.() ?? false,
    authorizeInternal: (req) => (opts.authorizeInternal ? opts.authorizeInternal(req) : false),

    async boot() {
      startedAt = now();
      const deadline = startedAt + bootTimeoutMs;
      const targets = bootTargets();
      await Promise.all(
        targets.map(async ({ rt, mode }) => {
          await probeOnce(rt, false, true);
          if (bootMode !== 'block' || mode === 'warn') return;
          while (!done(rt) && now() + bootRetryDelayMs < deadline) {
            await sleep(bootRetryDelayMs);
            await probeOnce(rt, false, true);
          }
        }),
      );
      if (bootMode === 'block') {
        const failed = targets.filter(({ rt, mode }) => mode === 'block' && !done(rt));
        if (failed.length) {
          throw new Error(
            `readiness boot failed for ${service} after ${now() - startedAt}ms: ${failed
              .map(({ rt }) => `${rt.d.name}(${rt.lastReason ?? 'error'})`)
              .join(', ')}`,
          );
        }
      }
      return render(snapshot(false), 'internal');
    },

    start() {
      if (started) return;
      started = true;
      startedAt ??= now();
      for (const rt of rts) {
        if (rt.lastAttemptAt === undefined) void probeOnce(rt, false, true);
        schedule(rt);
      }
    },

    stop() {
      started = false;
      for (const rt of rts) {
        if (rt.timer) clearTimeout(rt.timer);
        rt.timer = undefined;
      }
    },

    report(level = 'public') {
      return render(snapshot(false), level);
    },

    async deepReport(level = 'public') {
      if (!deepCache || now() - deepCache.at >= deepCacheMs) {
        deepInFlight ??= Promise.all(rts.map((rt) => probeOnce(rt, true, false)))
          .then(() => {
            deepCache = snapshot(true);
            return deepCache;
          })
          .finally(() => {
            deepInFlight = undefined;
          });
        return render(await deepInFlight, level);
      }
      return render(deepCache, level);
    },

    observe(name, outcome, reason) {
      const rt = byName.get(name);
      if (!rt) return;
      if (outcome === 'failure') {
        opts.onEvent?.({ type: 'observed_failure', name, ...(reason ? { reason } : {}) });
        return;
      }
      if (rt.hasSucceeded && !rt.neutral && rt.consecutiveFailures < threshold(rt)) {
        const t = now();
        rt.trafficOkAt = t;
        rt.lastSuccessAt = t;
        rt.lastRefreshAt = t;
      }
    },
  };
}

