/** Deep readiness types (soa#517). Semantics: docs/deep-readiness.md. */

export type DependencyKind =
  | 'postgres'
  | 'prisma'
  | 'mongo'
  | 'redis'
  | 'rabbitmq'
  | 'http'
  | 'openfga'
  | 'aws-s3'
  | 'aws-ssm'
  | 'aws-kms'
  | 'custom';

/** Kinds with a built-in default probe. Others require an explicit `probe`. */
export const BUILTIN_PROBE_KINDS: readonly DependencyKind[] = [
  'postgres',
  'prisma',
  'mongo',
  'redis',
  'rabbitmq',
  'http',
];

export type Criticality = 'critical' | 'optional';

/** After first success every failure degrades (200) unless scope is 'task' (503). */
export type DependencyScope = 'task' | 'shared';

export type ProbeReason =
  | 'timeout'
  | 'connection_refused'
  | 'dns'
  | 'tls'
  | 'auth'
  | 'schema'
  | 'unexpected_response'
  | 'not_ready'
  /** Pool-acquire timeout. Neutral: degrades, never counts as a failure or drives a 503. */
  | 'pool_exhausted'
  | 'error';

export interface ProbeOutcome {
  ok: boolean;
  reason?: ProbeReason;
}

export type CriticalitySpec =
  | { criticality: 'critical'; scope: DependencyScope }
  | { criticality: 'optional' };

interface DependencyDeclarationBase<C> {
  /** Stable id used in the report and metrics. Unique per service. */
  name: string;
  kind: DependencyKind;
  /** Thunk returning the REAL client the app uses. null/undefined = not configured. */
  client: () => C | null | undefined;
  /** Kind-specific target: exchange name (rabbitmq), URL (http). */
  target?: string;
  /** 'skipped' is the default only when EXEC_ENV is exactly 'local' or 'ci'; otherwise 'fail'. */
  whenAbsent?: 'skipped' | 'fail';
  /**
   * Overrides the kind's default probe. Required for 'custom', 'openfga' and 'aws-*'.
   * Must not retry and must bypass app circuit breakers. Resolve/resolve-void = ok; throw or {ok:false} = failure.
   */
  probe?: (client: C, signal: AbortSignal) => Promise<ProbeOutcome | void>;
  /** Deeper check (schema/grant/column). Deep path only; never feeds /health/ready. */
  schemaProbe?: (client: C, signal: AbortSignal) => Promise<ProbeOutcome | void>;
  timeoutMs?: number;
  intervalMs?: number;
  /** Consecutive failures before 'failing' (default 2). */
  failureThreshold?: number;
  /** Boot behaviour. Default: critical => block, optional => skip. */
  boot?: 'block' | 'warn' | 'skip';
}

export type DependencyDeclaration<C = unknown> = DependencyDeclarationBase<C> & CriticalitySpec;

declare const anyDependencyBrand: unique symbol;

/** Branded: a raw object literal does not type-check; callers must go through `dep()`. */
export type AnyDependency = { readonly [anyDependencyBrand]: true; readonly name: string };

export interface DependencyManifest {
  service: string;
  dependencies: readonly AnyDependency[];
}

/**
 * READINESS_BOOT (dispatch-settable, workflow default 'block'). warn: boot continues, /ready stays
 * 503 until first success. open: warn + first-success gate off. open never lifts the stale-cache 503.
 */
export type BootMode = 'block' | 'warn' | 'open';

export interface ProbeScheduleOptions {
  /** Active probe cadence per dependency (default 15000, +-20% jitter). */
  intervalMs?: number;
  /** Per-probe hard timeout (default 2000). */
  timeoutMs?: number;
  /** Max wait for a blocking boot (default 60000). */
  bootTimeoutMs?: number;
  /** Pause between boot attempts (default 2000). */
  bootRetryDelayMs?: number;
  /** Minimum gap between any two active probes of one dependency, deep calls included (default 1000). */
  minProbeGapMs?: number;
  /** Deep report cache TTL (default 5000). */
  deepCacheMs?: number;
  /** No probe attempt or traffic success within this window = stale cache = blocked loop => 503 (default 60000). */
  staleAfterMs?: number;
}

export type DependencyState = 'starting' | 'ok' | 'degraded' | 'failing' | 'stale' | 'skipped';

export interface DependencyReport {
  name: string;
  kind: DependencyKind;
  criticality: Criticality;
  scope?: DependencyScope;
  state: DependencyState;
  reason?: ProbeReason;
  latencyMs?: number;
  lastSuccessAgeMs?: number;
  consecutiveFailures: number;
  level: 'cached' | 'deep';
}

/**
 * degraded: serves (200) with a non-ok dependency: optional failing, critical failing after first
 * success (scope shared), pool_exhausted, or boot mode open with a dependency not yet ok.
 */
export type ReadinessVerdict = 'ready' | 'degraded' | 'not_ready' | 'draining' | 'starting';

export interface ReadinessReport {
  schema: 'saga.readiness/v1';
  service: string;
  verdict: ReadinessVerdict;
  httpStatus: 200 | 503;
  build: { colour?: string; version?: string; environment?: string; deployedAt?: string };
  generatedAt: string;
  bootMode: BootMode;
  summary: { critical: { ok: number; failing: number }; optional: { ok: number; failing: number } };
  /** internal detail only */
  dependencies?: DependencyReport[];
  /** internal detail only; legacy shape, migration aid */
  checks?: Record<string, { ready: boolean; detail: string }>;
}

export type DetailLevel = 'public' | 'internal';

export type ReadinessEvent =
  | { type: 'probe_failure'; name: string; reason: ProbeReason }
  | { type: 'observed_failure'; name: string; reason?: ProbeReason }
  | { type: 'verdict'; verdict: ReadinessVerdict; previous?: ReadinessVerdict };

export interface DeepReadiness {
  /** Boot self-test per READINESS_BOOT. Resolves with the report; rejects at the deadline in 'block' mode. */
  boot(): Promise<ReadinessReport>;
  start(): void;
  stop(): void;
  /** Cache only; zero dependency I/O. */
  report(level?: DetailLevel): ReadinessReport;
  /** Fresh active probes incl. schemaProbe; rate-limited, coalesced, cached. */
  deepReport(level?: DetailLevel): Promise<ReadinessReport>;
  /** Traffic success suppresses active probes. Failures are metric-only. */
  observe(name: string, outcome: 'success' | 'failure', reason?: ProbeReason): void;
  readonly bootMode: BootMode;
  /** For mountDeepReadiness. */
  authorizeInternal(req: unknown): boolean | Promise<boolean>;
  isDraining(): boolean;
}

export interface CreateDeepReadinessOptions extends ProbeScheduleOptions {
  manifest: DependencyManifest;
  /** Test seam; production reads EXEC_ENV only. Unset/unknown => deployed (fail closed). */
  env?: string;
  /** Test seam; production reads READINESS_BOOT. Unknown value => 'block'. */
  bootMode?: BootMode;
  isDraining?: () => boolean;
  /** Gate for the internal detail level. Default deny. See createBearerAuthorizer. */
  authorizeInternal?: (req: unknown) => boolean | Promise<boolean>;
  /** Metrics/log hook. Receives enum reasons only. */
  onEvent?: (event: ReadinessEvent) => void;
  /** Raw probe errors for the service logger. Never serialised into responses. */
  onProbeError?: (name: string, err: unknown) => void;
  now?: () => number;
}
