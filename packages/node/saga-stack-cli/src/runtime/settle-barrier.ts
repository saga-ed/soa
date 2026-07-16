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
 *  - `makeSettleBarrier` (follow-on change in this series) — the pre-bake
 *    quiescence barrier: poll the iam DBs + devLogin until the roster-sync
 *    pipeline is drained, so a per-stage bake never dumps torn state.
 *
 * Both compose EXISTING seams — `PgProbe.scalar` (docker-exec psql) and
 * `CookiePoster` (the devLogin POST) — plus an injectable `sleep`, so unit
 * tests script every probe answer and never wait wall-clock time.
 *
 * INVARIANT: real IO stays in `src/runtime/**`; the orchestrator consumes these
 * only via `ExecDeps` (`preflight` / `settleBarrier`), never by importing this
 * module at runtime from `core/**` or `e2e-checkpoint-exec.ts`.
 */

import type { DevLoginRequest } from '../core/login.js';
import type { CookiePoster } from './http-post.js';

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
