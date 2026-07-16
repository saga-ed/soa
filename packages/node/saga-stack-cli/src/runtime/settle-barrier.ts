/**
 * Settle probes for flow-produced iam state (soa#327) — the runtime IO half of
 * two guards that share one truth: "this stack's state is only usable when the
 * flow's OWN personas can devLogin".
 *
 *  - `makePersonaPreflight` — the tunnel post-restore probe: ONE devLogin POST
 *    (with capped transport-class retries) whose final status the orchestrator
 *    turns into a verdict (200 = usable, 401/404 = torn checkpoint, 403 =
 *    devLogin disabled). The RETRY policy lives here; the VERDICT policy stays
 *    in the orchestrator where the fail-loud messages live.
 *  - `makeSettleBarrier` — the pre-bake quiescence barrier: poll the iam DBs +
 *    devLogin until the roster-sync pipeline is drained, so a per-stage bake
 *    never dumps torn state (soa#327 walkthrough: per-stage checkpoints whose
 *    iam_pii dump lacked the personas roster-sync creates ⇒ devLogin 401 after
 *    restore).
 *
 * Both compose EXISTING seams — `PgProbe.scalar` (docker-exec psql) and
 * `CookiePoster` (the devLogin POST) — plus an injectable `sleep`, so unit
 * tests script every probe answer and never wait wall-clock time.
 *
 * INVARIANT: real IO stays in `src/runtime/**`; the orchestrator consumes these
 * only via `ExecDeps` (`preflight` / `settleBarrier`), never by importing this
 * module at runtime from `core/**` or `e2e-checkpoint-exec.ts`.
 */

import { buildDevLoginRequest, resolveIamUrl } from '../core/login.js';
import type { DevLoginRequest } from '../core/login.js';
import type { CookiePoster } from './http-post.js';
import type { PgProbe } from './pg-probe.js';
import { postgresContainer } from './snapshot-store.js';

/** Injectable wait — tests replace it so retries/polls are instant. */
export type SleepFn = (ms: number) => Promise<void>;

/** The production sleep: real time passes only here. */
export const realSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── tunnel persona preflight (post-restore) ─────────────────────────────────

/**
 * Preflight retry policy: transport-class results (status 0 = refused/timeout,
 * 5xx = proxy/service hiccup) are retried this many times, this far apart —
 * generous enough to ride out a tunnel blip, capped so a genuinely dead iam
 * fails in ~15s instead of hanging a session. Exported so tests pin them.
 */
export const PREFLIGHT_ATTEMPTS = 3;
export const PREFLIGHT_RETRY_DELAY_MS = 5000;

/**
 * POST one devLogin and return the FINAL HTTP status after capped
 * transport-class retries. Never throws — the orchestrator owns the verdict.
 */
export type PersonaPreflight = (req: DevLoginRequest) => Promise<number>;

/** Build the production preflight from the command's poster seam. */
export function makePersonaPreflight(deps: {
  poster: CookiePoster;
  log: (line: string) => void;
  sleep?: SleepFn;
}): PersonaPreflight {
  const sleep = deps.sleep ?? realSleep;
  return async (req: DevLoginRequest): Promise<number> => {
    let status = 0;
    for (let attempt = 1; attempt <= PREFLIGHT_ATTEMPTS; attempt++) {
      if (attempt > 1) await sleep(PREFLIGHT_RETRY_DELAY_MS);
      ({ status } = await deps.poster.post(req.url, { origin: req.origin, body: req.body }));
      // Only transport-class results are retryable. 2xx/3xx/4xx are ANSWERS —
      // return immediately: a 401 IS the torn-checkpoint verdict; retrying it
      // would only delay the loud error the caller is about to raise.
      if (status !== 0 && status < 500) return status;
      deps.log(
        `… tunnel preflight: devLogin for ${req.email} → ${status === 0 ? 'no response' : `HTTP ${status}`} ` +
          `(attempt ${attempt}/${PREFLIGHT_ATTEMPTS})`,
      );
    }
    return status;
  };
}

// ── bake quiescence barrier (pre-dump) ──────────────────────────────────────

/**
 * Barrier polling policy. The measured settle lag is <1.1s end-to-end (outbox
 * relay drain; the pii write itself is SYNCHRONOUS in-request — soa#327
 * ground-truth experiment), so 2.5s polls with a 120s cap is deliberately
 * generous: a healthy stack settles on the first or second poll; the cap only
 * fires when something is genuinely wedged, and then a red bake beats a torn
 * checkpoint. Exported so tests pin them. The cap is enforced as a POLL COUNT
 * (not wall clock) so a fake sleep keeps the timeout deterministic.
 */
export const SETTLE_POLL_INTERVAL_MS = 2500;
export const SETTLE_TIMEOUT_MS = 120_000;
export const SETTLE_MAX_POLLS = Math.ceil(SETTLE_TIMEOUT_MS / SETTLE_POLL_INTERVAL_MS);

/** What the orchestrator tells the barrier about the bake it is gating. */
export interface SettleBarrierContext {
  /** The checkpoint about to be baked (for the log/error lines). */
  fixtureId: string;
  /** The just-green stage. */
  stageId: string;
  /** The flow-declared settle personas — devLogin 200 for EACH defines "settled". */
  personas: string[];
}

/** Await quiescence before a bake; throws (never bakes torn) on timeout. */
export type SettleBarrier = (ctx: SettleBarrierContext) => Promise<void>;

/** One sample of the iam settle signal. */
interface SettleSample {
  users: string;
  pii: string;
  outboxUnpublished: string;
}

/**
 * Build the production barrier. "Settled" (soa#327 measured signal) =
 *  (A) iam_local outbox_event has NO unpublished rows (the relay feeding the
 *      genuinely-async followers — iam.events → programs-api projections — has
 *      no pending work), AND
 *  (C) the (iam_local users, iam_pii_local user_pii) count pair is IDENTICAL
 *      across two consecutive polls (user_pii's only non-seed writer runs
 *      synchronously inside the user-creating HTTP request, so pii can trail
 *      users only within a single in-flight request; stability closes that
 *      window), AND
 *  devLogin returns 200 for every flow-declared persona (the DIRECT probe of
 *  the observed failure: alex.tutor 401 after a torn per-stage restore).
 * Signal (B) of the hunt (rabbitmq queue depth) is deliberately omitted: it
 * measured 0 across every experiment (consumers keep pace), and probing it
 * would need a new rabbitmqctl seam for a term (A) already dominates.
 *
 * Count equality between users and pii is NOT required — bootstrap/system
 * users legitimately have no pii row. A probe error ('' scalar) is treated as
 * UNSETTLED, never as a stable value ('' === '' must not pass the bar).
 */
export function makeSettleBarrier(deps: {
  probe: PgProbe;
  poster: CookiePoster;
  log: (line: string) => void;
  slot?: number;
  sleep?: SleepFn;
}): SettleBarrier {
  const sleep = deps.sleep ?? realSleep;

  return async (ctx: SettleBarrierContext): Promise<void> => {
    // Resolved at CALL time: the command ran applyInstanceEnv first, so this is
    // the slot's own container (same contract as the checkpoint store).
    const container = postgresContainer();
    const iamUrl = resolveIamUrl({ slot: deps.slot });

    const sample = async (): Promise<SettleSample> => ({
      users: await deps.probe.scalar(container, 'iam_local', 'SELECT count(*) FROM users'),
      pii: await deps.probe.scalar(container, 'iam_pii_local', 'SELECT count(*) FROM user_pii'),
      outboxUnpublished: await deps.probe.scalar(
        container,
        'iam_local',
        'SELECT count(*) FROM outbox_event WHERE published_at IS NULL',
      ),
    });

    const personasLoginOk = async (): Promise<boolean> => {
      for (const email of ctx.personas) {
        const req = buildDevLoginRequest(email, iamUrl);
        const { status } = await deps.poster.post(req.url, { origin: req.origin, body: req.body });
        if (status !== 200) {
          deps.log(`… settle barrier: devLogin for ${email} → HTTP ${status} (not settled yet)`);
          return false;
        }
      }
      return true;
    };

    let prev = await sample();
    for (let poll = 1; poll <= SETTLE_MAX_POLLS; poll++) {
      await sleep(SETTLE_POLL_INTERVAL_MS);
      const cur = await sample();
      const countsValid = cur.users !== '' && cur.pii !== '';
      const stable = countsValid && cur.users === prev.users && cur.pii === prev.pii;
      const drained = cur.outboxUnpublished === '0';
      // devLogin is probed only once counts look settled — it mints session
      // state, so don't hammer it every poll while the roster is still moving.
      if (stable && drained && (await personasLoginOk())) {
        deps.log(
          `==> settle barrier: ${ctx.fixtureId} settled after ${poll} poll(s) ` +
            `(users=${cur.users} pii=${cur.pii} outbox_unpublished=0, devLogin 200 × ${ctx.personas.length})`,
        );
        return;
      }
      prev = cur;
    }

    throw new Error(
      `settle barrier TIMED OUT after ${SETTLE_MAX_POLLS} polls (~${Math.round(SETTLE_TIMEOUT_MS / 1000)}s) ` +
        `before baking '${ctx.fixtureId}' (stage '${ctx.stageId}') — refusing to dump possibly-torn state. ` +
        `Last signal: users=${prev.users || '?'} pii=${prev.pii || '?'} ` +
        `outbox_unpublished=${prev.outboxUnpublished || '?'}; ` +
        `personas: ${ctx.personas.join(', ')}. The stage may need a retry (known async-settle flake class), ` +
        'or iam-api / the outbox relay is wedged.',
    );
  };
}
