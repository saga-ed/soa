/**
 * The HTTP health-probe seam (plan §7.2 "M2 — native status/verify").
 *
 * `stack status` and `stack verify` are being RE-IMPLEMENTED natively in M2:
 * instead of shelling out to up.sh --status / verify.sh, they derive the
 * health-probe list from the MANIFEST (closing verify.sh's content-api :3009
 * gap) and probe each service's `<lane>/<healthPath>` themselves. That HTTP IO
 * is the ONE thing those commands can't keep pure — so it lives behind this
 * injectable `HealthProber`, mirroring the `Runner` process seam in `exec.ts`.
 *
 * Production wires `makeRealProber()` (a short-timeout `fetch` GET, the only
 * place a real network request is made); the status/verify TESTS substitute a
 * fake prober (via `BaseCommand.prototype.getProber`) that returns canned
 * results, so the native probe logic is asserted WITHOUT hitting the network or
 * needing a running stack.
 *
 * SEAM ONLY for the foundation phase: this is the interface + real impl + the
 * `getProber()` injection point on BaseCommand. It is intentionally NOT yet
 * wired into status/verify — the M2 build phase does that.
 *
 * INVARIANT (plan hard constraint): network IO lives only in `src/runtime/**`;
 * `src/core/**` never imports this and stays pure.
 */

/** The outcome of a single health probe. */
export interface ProbeResult {
  /** True iff the endpoint answered with a 2xx status. */
  ok: boolean;
  /** HTTP status code when a response was received; omitted on a transport/timeout error. */
  status?: number;
  /**
   * Response body, truncated to `BODY_LIMIT`. Required by `ss env verify`:
   * deployed envs sit behind a wildcard ALB whose default action answers 200
   * for any unmatched host, so ONLY the body distinguishes a real service from
   * "nothing is routed here". Local callers (`stack verify`) ignore it.
   */
  body?: string;
}

/** Cap on the captured body — health payloads are tiny; frontends are not. */
const BODY_LIMIT = 512;

/**
 * The injectable HTTP seam. One method: GET a URL, resolve to a `ProbeResult`.
 * A prober NEVER throws for a down endpoint — an unreachable host / timeout /
 * non-HTTP error resolves to `{ ok: false }` so callers can aggregate a health
 * table without try/catch around every probe.
 */
export interface HealthProber {
  probe(url: string): Promise<ProbeResult>;
}

/** Options for the real prober. */
export interface RealProberOptions {
  /** Per-probe timeout in ms before the request is aborted and counted as down. Default 2000. */
  timeoutMs?: number;
}

/**
 * The production prober: a `fetch` GET with a short AbortController timeout.
 * Any failure (DNS, refused connection, timeout, malformed response) is folded
 * into `{ ok: false }` rather than thrown — `ok` reflects a 2xx response.
 */
export function makeRealProber(opts: RealProberOptions = {}): HealthProber {
  const timeoutMs = opts.timeoutMs ?? 2000;
  return {
    async probe(url: string): Promise<ProbeResult> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, { method: 'GET', signal: controller.signal });
        let body: string | undefined;
        try {
          body = (await res.text()).slice(0, BODY_LIMIT);
        } catch {
          body = undefined; // a body that won't read never invalidates the status
        }
        return { ok: res.ok, status: res.status, body };
      } catch {
        return { ok: false };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
