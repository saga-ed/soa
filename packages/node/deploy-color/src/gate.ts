export type EnvLike = Record<string, string | undefined>;

export interface GateLogger {
    info(msg: string): void;
    warn(msg: string): void;
}

export interface GateDecision {
    active: boolean;
    reason: string;
}

/** Own blue/green colour from `deployment.identifier` in OTEL_RESOURCE_ATTRIBUTES; null for main, absent or anything else. */
export function getOwnColor(env: EnvLike = ambientEnv()): 'blue' | 'green' | null {
    for (const pair of env.OTEL_RESOURCE_ATTRIBUTES?.split(',') ?? []) {
        const eq = pair.indexOf('=');
        if (eq === -1 || pair.slice(0, eq).trim() !== 'deployment.identifier') continue;
        const value = pair.slice(eq + 1).trim();
        return value === 'blue' || value === 'green' ? value : null;
    }
    return null;
}

/** Pure decision. Every unknown input is active: the gate only ever narrows when it is certain. */
export function decide(ownColor: string | null, value: string | undefined): GateDecision {
    if (ownColor !== 'blue' && ownColor !== 'green') return { active: true, reason: 'own colour is not blue/green' };
    if (value === undefined) return { active: true, reason: 'no active-color value' };
    if (value === 'none') return { active: false, reason: 'active colour is none' };
    if (value === 'blue' || value === 'green') {
        return value === ownColor
            ? { active: true, reason: `own=${ownColor} matches active colour` }
            : { active: false, reason: `own=${ownColor} active=${value}` };
    }
    return { active: true, reason: `unrecognised active-color value '${value}'` };
}

export function isParameterNotFound(err: unknown): boolean {
    return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'ParameterNotFound';
}

export interface ResolveGateArgs {
    ownColor: string | null;
    parameterName: string | undefined;
    getParameter: (name: string) => Promise<string | undefined>;
}

export interface ResolveGateResult extends GateDecision {
    /** Set only when an unexpected read error was swallowed to stay active. */
    warning?: string;
}

/** One-shot read-and-decide for scheduled jobs. Fails open on any read error. */
export async function resolveGate(args: ResolveGateArgs): Promise<ResolveGateResult> {
    const { ownColor, parameterName, getParameter } = args;
    if (!parameterName) return { active: true, reason: 'ACTIVE_COLOR_PARAM not set' };
    if (ownColor !== 'blue' && ownColor !== 'green') return { active: true, reason: 'own colour is not blue/green' };
    try {
        return decide(ownColor, await getParameter(parameterName));
    } catch (err) {
        if (isParameterNotFound(err)) return { active: true, reason: `${parameterName} not found` };
        return {
            active: true,
            reason: 'active-color param read failed; proceeding active',
            warning: err instanceof Error ? err.message : String(err),
        };
    }
}

export interface ActiveColorGateOpts {
    getParameter: (name: string) => Promise<string | undefined>;
    /** Defaults to env.ACTIVE_COLOR_PARAM. Unset => gate is permanently active and never reads. */
    parameterName?: string;
    ownColor?: string | null;
    env?: EnvLike;
    pollIntervalMs?: number;
    /** Fraction of the interval added or removed at random per poll. */
    jitter?: number;
    bootTimeoutMs?: number;
    logger?: GateLogger;
    random?: () => number;
}

export interface GateState {
    active: boolean;
    value: string | undefined;
    own: string | null;
    lastReadAt: number | null;
    /** True while the most recent read failed and the last known value is being held. */
    stale: boolean;
    reason: string;
}

export type GateChangeListener = (active: boolean, value: string | undefined) => void;

export interface ActiveColorGate {
    start(): Promise<void>;
    stop(): void;
    refresh(): Promise<void>;
    isActive(): boolean;
    state(): GateState;
    /** Fires only when `isActive()` flips; returns an unsubscribe function. */
    on(event: 'change', listener: GateChangeListener): () => void;
}

const noopLogger: GateLogger = { info: () => {}, warn: () => {} };

export function createActiveColorGate(opts: ActiveColorGateOpts): ActiveColorGate {
    const env = opts.env ?? ambientEnv();
    const own = opts.ownColor !== undefined ? opts.ownColor : getOwnColor(env);
    const parameterName = opts.parameterName ?? env.ACTIVE_COLOR_PARAM;
    const pollIntervalMs = opts.pollIntervalMs ?? 10_000;
    const jitter = opts.jitter ?? 0.2;
    const bootTimeoutMs = opts.bootTimeoutMs ?? 3_000;
    const logger = opts.logger ?? noopLogger;
    const random = opts.random ?? Math.random;
    const enabled = Boolean(parameterName) && (own === 'blue' || own === 'green');

    let active = true;
    let value: string | undefined;
    let reason = enabled ? 'not read yet' : 'gate disabled';
    let lastReadAt: number | null = null;
    let stale = false;
    let stopped = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight: Promise<void> | null = null;
    let warned = false;
    const listeners = new Set<GateChangeListener>();

    function apply(next: string | undefined, why: string): void {
        value = next;
        const decision = decide(own, next);
        reason = why || decision.reason;
        if (decision.active !== active) {
            active = decision.active;
            logger.info(`[ActiveColorGate] active=${active} (${decision.reason})`);
            for (const l of [...listeners]) {
                try {
                    l(active, value);
                } catch (err) {
                    logger.warn(`[ActiveColorGate] change listener threw: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
        }
    }

    async function readOnce(): Promise<void> {
        if (!enabled || !parameterName) return;
        try {
            const v = await opts.getParameter(parameterName);
            lastReadAt = Date.now();
            stale = false;
            warned = false;
            apply(v, '');
        } catch (err) {
            if (isParameterNotFound(err)) {
                lastReadAt = Date.now();
                stale = false;
                warned = false;
                apply(undefined, `${parameterName} not found`);
                return;
            }
            stale = true;
            if (!warned) {
                warned = true;
                logger.warn(
                    `[ActiveColorGate] read of ${parameterName} failed; holding last value '${value ?? 'none-known'}': ${err instanceof Error ? err.message : String(err)}`,
                );
            }
        }
    }

    function refresh(): Promise<void> {
        inFlight ??= readOnce().finally(() => {
            inFlight = null;
        });
        return inFlight;
    }

    function schedule(): void {
        if (stopped || timer) return;
        const delta = (random() * 2 - 1) * jitter * pollIntervalMs;
        timer = setTimeout(() => {
            timer = null;
            void refresh().finally(schedule);
        }, Math.max(0, pollIntervalMs + delta));
        timer.unref?.();
    }

    return {
        async start() {
            stopped = false;
            if (!enabled) return;
            let bootTimer: ReturnType<typeof setTimeout> | undefined;
            const timeout = new Promise<'timeout'>((resolve) => {
                bootTimer = setTimeout(() => resolve('timeout'), bootTimeoutMs);
                bootTimer.unref?.();
            });
            const outcome = await Promise.race([refresh().then(() => 'done' as const), timeout]);
            clearTimeout(bootTimer);
            if (outcome === 'timeout') {
                logger.warn(`[ActiveColorGate] boot read of ${parameterName} timed out after ${bootTimeoutMs}ms; starting active`);
            }
            schedule();
        },
        stop() {
            stopped = true;
            if (timer) clearTimeout(timer);
            timer = null;
        },
        refresh,
        isActive: () => active,
        state: () => ({ active, value, own, lastReadAt, stale, reason }),
        on(_event, listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
}

function ambientEnv(): EnvLike {
    const proc = (globalThis as { process?: { env?: EnvLike } }).process;
    return proc?.env ?? {};
}
