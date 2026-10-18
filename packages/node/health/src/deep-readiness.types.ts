/**
 * DESIGN STUBS for deep readiness (soa#517). Types only, no runtime, not exported
 * from index.ts until the design in docs/deep-readiness.md is approved.
 */

/** Kinds the library ships adapters for. `custom` covers anything else. */
export type DependencyKind =
  | 'postgres'
  | 'mongo'
  | 'redis'
  | 'rabbitmq'
  | 'http'
  | 'openfga'
  | 'aws-s3'
  | 'aws-ssm'
  | 'aws-kms'
  | 'custom';

/**
 * critical: gates readiness until first success; afterwards every failure is degraded/200 unless scope 'task'.
 * optional: failure => degraded (200). REQUIRED on every declaration, no per-kind default.
 */
export type Criticality = 'critical' | 'optional';

/**
 * After first success a failing critical dependency => degraded (200) + metric, whether 'shared' (the
 * default intent) or not. Only an explicit 'task' scope, or a stale cache/blocked event loop, => 503.
 * Pending Seth confirmation.
 */
export type DependencyScope = 'task' | 'shared';

/** Outcome of one active probe. Throwing is also a failure; the runner classifies it. */
export interface ProbeOutcome {
  ok: boolean;
  /** Closed vocabulary, never free text from the dependency (see Security). */
  reason?: ProbeReason;
}

export type ProbeReason =
  | 'timeout'
  | 'connection_refused'
  | 'dns'
  | 'tls'
  | 'auth'
  | 'schema'
  | 'unexpected_response'
  | 'not_ready'
  /** Pool-acquire timeout. Neutral: degrades, never drives a 503. */
  | 'pool_exhausted'
  | 'error';

/**
 * Declares one dependency. `client` is a thunk returning the REAL instance the app
 * uses (the Prisma client, the node-redis client, the OpenFGA SDK client, the
 * wrapper that carries the shared fetch agent). The runner never opens its own connection.
 */
export type CriticalitySpec =
  | { criticality: 'critical'; scope: DependencyScope }
  | { criticality: 'optional' };

export type DependencyDeclaration<C = unknown> = DependencyDeclarationBase<C> & CriticalitySpec;

interface DependencyDeclarationBase<C> {
  /** Stable id, used in the report and metrics. Unique per service. */
  name: string;
  kind: DependencyKind;
  /** Resolved lazily so DI containers and late-initialised clients work. null/undefined = not configured. */
  client: () => C | null | undefined;
  /**
   * If the client is not configured: 'skipped' (ready) or 'fail'. 'skipped' is the default
   * only when EXEC_ENV is exactly 'local' or 'ci'; unset/unknown EXEC_ENV is deployed => 'fail'.
   */
  whenAbsent?: 'skipped' | 'fail';
  /**
   * Override the kind's default probe. Required for 'custom' and every 'aws-*' kind (use an
   * operation the task role already performs). Must not retry; must bypass app circuit breakers.
   */
  probe?: (client: C, signal: AbortSignal) => Promise<ProbeOutcome | void>;
  /**
   * Optional deeper check (schema/grant/column mapping). Runs at boot and on
   * the deep path only; never on the TG-facing path.
   */
  schemaProbe?: (client: C, signal: AbortSignal) => Promise<ProbeOutcome | void>;
  /** Per-dependency overrides of the defaults in ProbeScheduleOptions. */
  timeoutMs?: number;
  intervalMs?: number;
  /** Consecutive failures before state flips to failing (default 2). */
  failureThreshold?: number;
  /** Freshness window: older than this without a success => stale => failing. */
  staleAfterMs?: number;
  /** Boot phase behaviour. Default: critical => block, optional => skip. READINESS_BOOT env overrides at runtime. */
  boot?: 'block' | 'warn' | 'skip';
}

declare const anyDependencyBrand: unique symbol;

/** Branded: a raw object literal does not type-check, callers must go through `dep()`. */
export type AnyDependency = { readonly [anyDependencyBrand]: true; readonly name: string };

/** Infers C from `client` so probe/schemaProbe are typed against the real client under strict mode. */
export declare function dep<C>(d: DependencyDeclaration<C>): AnyDependency;

export interface DependencyManifest {
  service: string;
  dependencies: readonly AnyDependency[];
}

/** Identity function that validates names/required fields and freezes the manifest. */
export declare function declareDependencies(manifest: DependencyManifest): DependencyManifest;

/**
 * READINESS_BOOT (dispatch-settable, workflow default 'block'). warn: boot continues, /ready stays 503 until first success.
 * open: warn + first-success gate off. open never lifts the stale-cache/event-loop 503.
 */
export type BootMode = 'block' | 'warn' | 'open';

export interface ProbeScheduleOptions {
  /** Active probe cadence per dependency (default 15000). */
  intervalMs?: number;
  /** Per-probe hard timeout (default 2000). Abort via AbortSignal where the client supports it. */
  timeoutMs?: number;
  /** Max wait for the boot self-test (default 60000). */
  bootTimeoutMs?: number;
  /** Minimum gap between ANY two active probes of the same dependency, incl. deep calls (default 1000). */
  minProbeGapMs?: number;
  /** Deep-path cache TTL (default 5000). */
  deepCacheMs?: number;
}

export type DependencyState = 'starting' | 'ok' | 'degraded' | 'failing' | 'stale' | 'skipped';

export interface DependencyReport {
  name: string;
  kind: DependencyKind;
  criticality: Criticality;
  state: DependencyState;
  reason?: ProbeReason;
  /** Latency of the last probe, rounded ms. */
  latencyMs?: number;
  /** Age of the last success. Absent before first success. */
  lastSuccessAgeMs?: number;
  consecutiveFailures: number;
  /** Which probe level produced this (live cache vs a fresh deep run). */
  level: 'cached' | 'deep';
}

/**
 * degraded: serves (HTTP 200) with a non-ok dependency: optional failing, shared critical failing
 * after first success, or a neutral signal (pool_exhausted, observe() failure). Always emits a metric.
 */
export type ReadinessVerdict = 'ready' | 'degraded' | 'not_ready' | 'draining' | 'starting';

/** Versioned, machine-readable. The same document feeds /ss, the twin and idle-colour smoke. */
export interface ReadinessReport {
  schema: 'saga.readiness/v1';
  service: string;
  verdict: ReadinessVerdict;
  /** HTTP status the TG path would return for this verdict. */
  httpStatus: 200 | 503;
  build: {
    colour?: string;
    version?: string;
    environment?: string;
    deployedAt?: string;
  };
  generatedAt: string;
  /** Present on 'internal' detail only. */
  dependencies?: DependencyReport[];
  /** Present on 'internal' detail only; legacy shape, migration aid. */
  checks?: Record<string, { ready: boolean; detail: string }>;
  /** 'warn'/'open' means this task is running unguarded. */
  bootMode: BootMode;
  /** Present on 'public' detail: counts only. */
  summary: { critical: { ok: number; failing: number }; optional: { ok: number; failing: number } };
}

export type DetailLevel = 'public' | 'internal';

export interface DeepReadiness {
  /** Run the boot self-test: every `boot: 'block'` dependency must pass (retrying) before resolve; rejects at the deadline. */
  boot(): Promise<ReadinessReport>;
  /** Start background probing. Idempotent. */
  start(): void;
  stop(): void;
  /** Reads cached state only; zero dependency I/O. Backs the TG path. */
  report(level?: DetailLevel): ReadinessReport;
  /** Fresh active probes (rate-limited, coalesced, cached deepCacheMs). Never a TG path. */
  deepReport(level?: DetailLevel): Promise<ReadinessReport>;
  /** Traffic success suppresses redundant active probes. Failures are metric-only: never change state or verdict. */
  observe(name: string, outcome: 'success' | 'failure', reason?: ProbeReason): void;
}

export interface CreateDeepReadinessOptions extends ProbeScheduleOptions {
  manifest: DependencyManifest;
  /** Test seam. Production reads EXEC_ENV only; unset/unknown => deployed (fail closed). Lane (twin/mirror) comes from the iac#898 LANE identity, not here. */
  env?: string;
  isDraining?: () => boolean;
  /** Internal-detail bearer (loaded from SSM by the service). Compared in constant time. Unset => internal unreachable. */
  internalBearerToken?: string;
}

export declare function createDeepReadiness(opts: CreateDeepReadinessOptions): DeepReadiness;

/**
 * Mounts: /health/live, /health/ready (TG), /health/deep (deploy smoke / humans).
 * Replaces mountReadinessRoutes for adopters; the old mounter stays for one major.
 */
export declare function mountDeepReadiness(app: unknown, dr: DeepReadiness): void;

/**
 * CI guard: asserts every declared dependency resolves to a probe (built-in for its
 * kind, or an explicit `probe`) and, when a `discover` list is given, that every
 * client the app constructs appears in the manifest. Used from a service unit test.
 */
export declare function assertManifestComplete(
  manifest: DependencyManifest,
  opts?: { discover?: readonly string[] },
): void;
