import { dep } from './manifest.js';
import type { AnyDependency, ProbeOutcome } from './types.js';

/** Structural view of soa-rabbitmq's ConnectionManager (no hard dependency on it). */
export interface BrokerConnectionLike {
  isConnected(): boolean;
  /** Epoch ms an established connection was lost; undefined while connected or never connected. */
  disconnectedSince(): number | undefined;
  /** True once the manager stopped retrying. */
  reconnectGaveUp(): boolean;
  /** Configured reconnect budget; read when `budgetMs` is not passed. 0 = no budget. */
  reconnectBudgetMs?(): number;
}

export interface RabbitDependencyOptions {
  /** Shared-dependency name (default 'rabbitmq'); the task-scoped one is `<name>-task`. */
  name?: string;
  /** Thunk returning the app's ConnectionManager. null/undefined = not configured. */
  connection: () => BrokerConnectionLike | null | undefined;
  /** Consumer services: false while connected means the consumer is cancelled or wedged. */
  isConsuming?: () => boolean;
  /** Longest outage tolerated as shared. Default: the manager's budget, else 15 min. */
  budgetMs?: number;
  /** Clock (epoch ms) for the budget check. */
  now?: () => number;
  /** Boot behaviour for both dependencies (default 'block'). */
  boot?: 'block' | 'warn' | 'skip';
  whenAbsent?: 'skipped' | 'fail';
}

export const DEFAULT_BROKER_BUDGET_MS = 15 * 60_000;

const NOT_READY: ProbeOutcome = { ok: false, reason: 'not_ready' };
const OK: ProbeOutcome = { ok: true };

/**
 * Two declarations encoding the broker-outage rule for `createDeepReadiness`:
 * - `<name>` (shared): fails whenever the broker is down. After first success this
 *   degrades (200) because every task sees the same outage.
 * - `<name>-task` (task): fails when the reconnect gave up, the outage outlived the
 *   budget, or the broker is up but the consumer is not consuming (503: replace the task).
 * Before the first successful probe a failure is still 503 (starting).
 */
export function rabbitDependency(opts: RabbitDependencyOptions): AnyDependency[] {
  const name = opts.name ?? 'rabbitmq';
  const now = opts.now ?? Date.now;
  const common = {
    kind: 'rabbitmq' as const,
    criticality: 'critical' as const,
    client: opts.connection,
    failureThreshold: 1,
    ...(opts.boot ? { boot: opts.boot } : {}),
    ...(opts.whenAbsent ? { whenAbsent: opts.whenAbsent } : {}),
  };

  const budgetOf = (c: BrokerConnectionLike): number =>
    opts.budgetMs ?? (c.reconnectBudgetMs ? c.reconnectBudgetMs() : DEFAULT_BROKER_BUDGET_MS);

  return [
    dep<BrokerConnectionLike>({
      ...common,
      name,
      scope: 'shared',
      probe: async (c) => (c.isConnected() ? OK : NOT_READY),
    }),
    dep<BrokerConnectionLike>({
      ...common,
      name: `${name}-task`,
      scope: 'task',
      probe: async (c) => {
        if (c.isConnected()) {
          return opts.isConsuming && !opts.isConsuming() ? NOT_READY : OK;
        }
        if (c.reconnectGaveUp()) return NOT_READY;
        const since = c.disconnectedSince();
        if (since === undefined) return OK; // never connected: the shared dependency gates boot
        const budget = budgetOf(c);
        return budget > 0 && now() - since > budget ? NOT_READY : OK;
      },
    }),
  ];
}
