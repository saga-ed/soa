/**
 * Attach-mode profiling: the IO half (signal + Chrome DevTools Protocol).
 *
 * INVARIANT (matches `launcher.ts`): signalling and sockets live ONLY here; the
 * decision logic is pure in `core/profile-plan.ts`. Every seam is injectable so
 * the command's wiring is testable without a real service.
 *
 * The capture sequence:
 *   1. SIGUSR1 the LISTENING pid — Node opens the V8 inspector on demand, so no
 *      launch-time flag is needed (see `core/inspector.ts` for why that matters).
 *   2. Poll `GET /json/list` until it answers — SIGUSR1 is asynchronous.
 *   3. `Profiler.enable` → `.start` → wait → `.stop`, which returns the profile.
 *
 * The artifact arrives over the wire while the process is alive, so it survives
 * the group-SIGKILL that `ss stack down` performs.
 *
 * Uses Node's global `WebSocket` — the `ws` package is not resolvable here.
 */

import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

/** A V8 CPU profile as returned by `Profiler.stop`. */
export interface CpuProfile {
  nodes: Array<{ id: number; hitCount?: number; callFrame?: { functionName?: string; url?: string } }>;
  samples?: number[];
  timeDeltas?: number[];
  startTime?: number;
  endTime?: number;
}

export interface ProfilerDeps {
  /** Send a signal to a pid. Default `process.kill`. */
  signal?: (pid: number, sig: NodeJS.Signals) => void;
  /** Fetch JSON from the inspector's HTTP endpoint. Default global `fetch`. */
  fetchJson?: (url: string) => Promise<unknown>;
  /** Open a CDP session over a websocket url. Default a global-`WebSocket` client. */
  connect?: (wsUrl: string) => Promise<CdpSession>;
  /** Sleep. Default a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Write the artifact, creating parent dirs. Default `fs.writeFileSync` + `mkdirSync`. */
  writeFile?: (path: string, body: string) => void;
  /** Resolve the pid listening on a port, for the post-signal identity check. */
  portOwner?: (port: number) => Promise<number | null>;
  /** Attempts to wait for the inspector to answer after SIGUSR1. Default 30. */
  attempts?: number;
  /** Delay between those attempts, ms. Default 100. */
  intervalMs?: number;
  /** Per-attempt HTTP timeout, ms — the dominant term in the poll's worst case. Default 2000. */
  fetchTimeoutMs?: number;
}

/** The minimal CDP surface the capture needs. */
export interface CdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): void;
}

export interface CaptureRequest {
  pid: number;
  port: number;
  durationMs: number;
  outPath: string;
  /** Skip SIGUSR1 — the target's inspector is already open (a re-attach). */
  alreadyOpen?: boolean;
}

export type CaptureResult =
  | { ok: true; outPath: string; profile: CpuProfile }
  | { ok: false; reason: string };

/** Open a CDP session using Node's built-in global WebSocket (no `ws` dependency). */
async function defaultConnect(wsUrl: string): Promise<CdpSession> {
  const socket = new WebSocket(wsUrl);
  type Waiter = { resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void };
  const pending = new Map<number, Waiter>();
  let nextId = 0;

  // Bounded, and the socket is closed on EVERY reject path — the caller's
  // `finally { session.close() }` cannot run for a connect that never returned.
  await new Promise<void>((resolve, reject) => {
    const fail = (err: Error) => {
      socket.close();
      reject(err);
    };
    const timer = setTimeout(() => fail(new Error(`inspector websocket timed out: ${wsUrl}`)), 10_000);
    socket.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    socket.onerror = () => {
      clearTimeout(timer);
      fail(new Error(`inspector websocket failed: ${wsUrl}`));
    };
  });

  socket.onmessage = (event: MessageEvent) => {
    const msg = JSON.parse(String(event.data)) as {
      id?: number;
      result?: Record<string, unknown>;
      error?: { message?: string; code?: number };
    };
    if (typeof msg.id !== 'number') return;
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    // A CDP `error` reply must REJECT — resolving it as {} let a failed
    // Profiler.enable/start pass silently and produced a capture against a
    // profiler that was never started.
    if (msg.error) waiter.reject(new Error(`CDP error: ${msg.error.message ?? 'unknown'}`));
    else waiter.resolve(msg.result ?? {});
  };

  // A mid-capture disconnect should surface immediately, not stall every
  // outstanding request for the full send timeout.
  socket.onclose = () => {
    for (const [id, waiter] of pending) {
      pending.delete(id);
      waiter.reject(new Error('inspector connection closed mid-capture'));
    }
  };

  // A socket that opens and THEN errors (or a command the target never answers)
  // would otherwise leave `send` pending forever and hang the CLI with no output.
  // Every request is therefore bounded and rejects with the method name.
  const SEND_TIMEOUT_MS = 30_000;

  return {
    send(method, params = {}) {
      const id = (nextId += 1);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out after ${SEND_TIMEOUT_MS}ms`));
        }, SEND_TIMEOUT_MS);
        pending.set(id, {
          resolve: (result) => {
            clearTimeout(timer);
            resolve(result);
          },
          reject: (err) => {
            clearTimeout(timer);
            reject(err);
          },
        });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close: () => socket.close(),
  };
}

/**
 * SIGUSR1 `pid`, wait for its inspector to answer on `port`, capture a CPU profile
 * for `durationMs`, and write it to `outPath`.
 *
 * Failure is always explicit. In particular, if the inspector never answers we say
 * so rather than reporting a success with an empty artifact — the silent-bind
 * failure (`address already in use`, visible only in the service's own log) is the
 * exact trap this command is built to avoid.
 */
export async function captureCpuProfile(
  req: CaptureRequest,
  deps: ProfilerDeps = {},
): Promise<CaptureResult> {
  const signal = deps.signal ?? ((pid, sig) => process.kill(pid, sig));
  const attempts = deps.attempts ?? 30;
  const intervalMs = deps.intervalMs ?? 100;
  const fetchTimeoutMs = deps.fetchTimeoutMs ?? 2000;
  // AbortSignal is mandatory here: a holder that accepts TCP but never answers HTTP
  // makes a bare fetch() hang forever, defeating the poll loop's own attempt bound.
  const fetchJson =
    deps.fetchJson ??
    (async (url: string) =>
      (await fetch(url, { signal: AbortSignal.timeout(fetchTimeoutMs) })).json());
  const connect = deps.connect ?? defaultConnect;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const writeFile =
    deps.writeFile ??
    ((p: string, b: string) => {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, b);
    });
  const portOwner = deps.portOwner ?? defaultPortOwner;

  if (!req.alreadyOpen) {
    try {
      signal(req.pid, 'SIGUSR1');
    } catch (err) {
      return { ok: false, reason: `could not signal pid ${req.pid}: ${(err as Error).message}` };
    }
  }

  // SIGUSR1 is async — poll until the inspector's HTTP endpoint answers.
  let wsUrl: string | undefined;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const list = (await fetchJson(`http://127.0.0.1:${req.port}/json/list`)) as Array<{
        webSocketDebuggerUrl?: string;
        type?: string;
        title?: string;
      }>;
      // Prefer the MAIN thread: a service using worker_threads publishes a target
      // per worker, and taking list[0] blindly can profile a worker while
      // reporting success for the service.
      const targets = (list ?? []).filter((t) => t.webSocketDebuggerUrl !== undefined);
      const main =
        targets.find((t) => t.type === 'node' && !/worker/i.test(t.title ?? '')) ??
        targets.find((t) => t.type === 'node') ??
        targets[0];
      wsUrl = main?.webSocketDebuggerUrl;
      if (wsUrl !== undefined) break;
    } catch {
      // not up yet
    }
    await sleep(intervalMs);
  }
  if (wsUrl === undefined) {
    return {
      ok: false,
      reason:
        `inspector never came up on port ${req.port} after SIGUSR1. The service may have failed to ` +
        `bind it — check its log for "address already in use".`,
    };
  }

  // The port answering is NOT proof it is OUR target answering. `inspector.open()`
  // on a taken port logs "address already in use" and returns normally, leaving the
  // loser running with no inspector — so a concurrent profile finds the FIRST
  // service's still-open inspector here and would capture it under our pid's name.
  // /json/list carries no pid, so identity comes from the port's actual owner.
  const owner = await portOwner(req.port);
  if (owner !== null && owner !== req.pid) {
    return {
      ok: false,
      reason:
        `inspector port ${req.port} is held by pid ${owner}, not ${req.pid}. Profiling is ` +
        `machine-wide (Node's inspector port takes no slot offset) — wait for the other ` +
        `profile to finish, then retry.`,
    };
  }

  let session: CdpSession;
  try {
    session = await connect(wsUrl);
  } catch (err) {
    return { ok: false, reason: `could not attach to inspector: ${(err as Error).message}` };
  }

  let profile: CpuProfile;
  try {
    await session.send('Profiler.enable');
    await session.send('Profiler.start');
    await sleep(req.durationMs);
    const stopped = (await session.send('Profiler.stop')) as { profile?: CpuProfile };
    if (!stopped.profile || !Array.isArray(stopped.profile.nodes)) {
      return { ok: false, reason: 'Profiler.stop returned no profile' };
    }
    profile = stopped.profile;
  } catch (err) {
    return { ok: false, reason: `profiling failed: ${(err as Error).message}` };
  } finally {
    session.close();
  }

  // Written OUTSIDE the capture try: a bad --out path must not be reported as a
  // profiling failure, and must not discard a profile that cost a full sampling
  // window against a live service.
  try {
    writeFile(req.outPath, JSON.stringify(profile));
  } catch (err) {
    return { ok: false, reason: `captured OK but could not write ${req.outPath}: ${(err as Error).message}` };
  }
  return { ok: true, outPath: req.outPath, profile };
}

/**
 * True when ANYTHING already holds the inspector port.
 *
 * Deliberately a raw TCP connect, not an HTTP probe. The port is frequently held
 * by a process that ACCEPTS the connection but never answers `/json/version` —
 * notably the `pnpm dev` wrapper, which is the launch tree's process-group leader
 * and so receives any group-delivered SIGUSR1 and opens a half-working inspector
 * of its own. An HTTP probe HANGS against that (verified: `curl` connects, then
 * waits forever), which would both defeat the guard and stall the CLI. A connect
 * that succeeds is enough to know the real service cannot bind.
 */
export async function inspectorPortBusy(
  port: number,
  deps: { probeTcp?: (port: number, timeoutMs: number) => Promise<boolean> } = {},
): Promise<boolean> {
  const probe = deps.probeTcp ?? tcpListening;
  return probe(port, 1000);
}

/**
 * The pid listening on `port`, or null when it can't be resolved. Null is
 * inconclusive, never "free" — callers must not read it as permission to proceed.
 */
async function defaultPortOwner(port: number): Promise<number | null> {
  try {
    const { stdout } = await promisify(execFile)('lsof', ['-ti', `:${port}`, '-sTCP:LISTEN']);
    const pid = Number.parseInt(stdout.trim().split('\n')[0] ?? '', 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

/** Resolve true when a TCP connect to 127.0.0.1:port succeeds within `timeoutMs`. */
function tcpListening(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    const done = (held: boolean) => {
      socket.destroy();
      resolve(held);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, '127.0.0.1');
  });
}
