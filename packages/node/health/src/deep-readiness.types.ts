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

/** critical: failure => not ready (503). optional: failure => degraded, still ready (200). */
export type Criticality = 'critical' | 'optional';

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
  | 'error';

/**
 * Declares one dependency. `client` is a thunk returning the REAL instance the app
 * uses (the Prisma client, the node-redis client, the OpenFGA SDK client, the
 * wrapper that carries the shared fetch agent). The runner never opens its own connection.
 */
export interface DependencyDeclaration<C = unknown> {
  /** Stable id, used in the report and metrics. Unique per service. */
  name: string;
  kind: DependencyKind;
  criticality: Criticality;
  /** Resolved lazily so DI containers and late-initialised clients work. null/undefined = not configured. */
  client: () => C | null | undefined;
  /**
   * If the client is not configured: 'skipped' (ready) or 'fail'. Default 'fail'
   * when criticality is critical and the environment is deployed (see EnvPolicy).
   */
  whenAbsent?: 'skipped' | 'fail';
  /** Override the kind's default probe. Required for kind 'custom'. */
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
  /** Boot phase behaviour. Default: critical => block, optional => skip. */
  boot?: 'block' | 'warn' | 'skip';
}

export interface DependencyManifest {
  service: string;
  dependencies: readonly DependencyDeclaration[];
}

/** Identity function that type-checks the declaration and freezes it. */
export declare function declareDependencies(manifest: DependencyManifest): DependencyManifest;

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
  /** Real traffic reports success/failure for a dependency, suppressing redundant active probes. */
  observe(name: string, outcome: 'success' | 'failure', reason?: ProbeReason): void;
}

export interface CreateDeepReadinessOptions extends ProbeScheduleOptions {
  manifest: DependencyManifest;
  /** Defaults to NODE_ENV/EXEC_ENV based; controls whenAbsent defaults. */
  env?: 'local' | 'ci' | 'dev' | 'prod';
  isDraining?: () => boolean;
  /** Authorises the internal detail level. Default: deny, so unauthenticated callers get 'public'. */
  authorizeInternal?: (req: unknown) => boolean;
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
