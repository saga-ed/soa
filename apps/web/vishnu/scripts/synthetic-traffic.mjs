import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const balanced = ['auth.whoami', 'programs.list', 'programs.get', 'schedules.get'];
export const profiles = {
  baseline: { concurrency: 1, interval: 1000, sequence: balanced },
  burst: { concurrency: 4, interval: 100, sequence: balanced },
  attendance: {
    concurrency: 1,
    interval: 1000,
    sequence: ['adm.getHistoricAttendanceByPrograms', 'programs.list', 'schedules.get', 'auth.whoami'],
  },
  mixed: {
    concurrency: 2,
    interval: 250,
    sequence: [
      'programs.list',
      'programs.get',
      'programs.list',
      'schedules.get',
      'programs.list',
      'programs.get',
      'programs.list',
      'auth.whoami',
    ],
  },
};

function integer(name, value, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new Error(`${name} must be an integer ${min}..${max}`);
  return n;
}

export function optionsFrom(values) {
  const profile = values.profile ?? 'baseline';
  if (!Object.hasOwn(profiles, profile))
    throw new Error('profile must be baseline, burst, mixed or attendance');
  return {
    profile,
    slot: integer('slot', values.slot, 0, 9),
    duration: integer('duration', values.duration ?? '60', 1, 600),
    concurrency: integer('concurrency', values.concurrency ?? profiles[profile].concurrency, 1, 8),
    interval: integer('interval', values.interval ?? profiles[profile].interval, 100, 10000),
    requests: integer('requests', values.requests ?? '2000', 2, 10000),
    cookieJar: values['cookie-jar'],
  };
}

export function localCookies(jar, now = Date.now()) {
  return jar
    .split('\n')
    .filter(line => line.startsWith('#HttpOnly_') || (line && !line.startsWith('#')))
    .map(line =>
      line
        .replace(/^#HttpOnly_/, '')
        .trimEnd()
        .split('\t')
    )
    .filter(
      p =>
        p.length === 7 &&
        ['localhost', '127.0.0.1'].includes(p[0]) &&
        p[3] === 'FALSE' &&
        (p[2] === '/' || p[2] === '/trpc') &&
        (p[4] === '0' || Number(p[4]) * 1000 > now)
    )
    .map(p => `${p[5]}=${p[6]}`)
    .join('; ');
}

export async function runTraffic(
  options,
  { fetchImpl = fetch, readJar = readFile, sleep = delay, emit = console.log, signal } = {}
) {
  const { slot, profile, duration, concurrency, interval, requests } = options;
  const state = `/tmp/sds-synthetic${slot ? `-s${slot}` : ''}`;
  const cookies = localCookies(await readJar(options.cookieJar ?? `${state}/cookies.txt`, 'utf8'));
  if (!cookies.split('; ').some(cookie => cookie.startsWith('iam_session='))) {
    throw new Error(`No valid local session; run ss stack login --slot ${slot}`);
  }
  const stats = new Map();
  const errors = [];
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  let count = 0;
  let stopped = false;
  let phase = 'preflight';
  let workloadStartedAt = null;
  let deadline = Infinity;

  async function request(procedure, programId) {
    // Fixed GET allowlist and loopback ports prevent accidental hosted or mutating traffic.
    const endpoint = {
      'auth.whoami': { port: 3010 },
      'programs.list': { port: 3006, input: { page: 1, limit: 5 } },
      'programs.get': { port: 3006, input: { id: programId } },
      'schedules.get': { port: 3008, input: { programId } },
      'adm.getHistoricAttendanceByPrograms': {
        port: 5005,
        // SDS uses SuperJSON; read the current UTC day without creating fixtures.
        input: { json: { programIds: [programId], dates: [startedAt.slice(0, 10)] } },
      },
    }[procedure];
    if (!endpoint) throw new Error('Procedure is not in the read-only allowlist');
    const url = new URL(`/trpc/${procedure}`, `http://localhost:${endpoint.port + slot * 1000}`);
    if (endpoint.input !== undefined) url.searchParams.set('input', JSON.stringify(endpoint.input));
    count++;
    const start = performance.now();
    let status = 0;
    let succeeded = false;
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: { cookie: cookies },
        redirect: 'error',
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
          : AbortSignal.timeout(10000),
      });
      status = response.status;
      if (!response.ok) throw new Error('HTTP failure');
      const body = await response.json();
      if (body.error || !body.result) throw new Error('Invalid tRPC response');
      succeeded = true;
      return body.result.data?.json ?? body.result.data;
    } catch {
      // Avoid logging response bodies, URLs with program identifiers, or session values.
      throw new Error(
        `${procedure}: ${status ? `HTTP ${status} or invalid tRPC response` : 'transport failure or interrupted request'}`
      );
    } finally {
      const key = `${phase}:${procedure}`;
      const row = stats.get(key) ?? { phase, procedure, failures: 0, timings: [], statuses: {} };
      row.timings.push(performance.now() - start);
      row.failures += succeeded ? 0 : 1;
      row.statuses[status] = (row.statuses[status] ?? 0) + 1;
      stats.set(key, row);
    }
  }

  emit(
    JSON.stringify({
      event: 'started',
      runId,
      startedAt,
      ...options,
      cookieJar: undefined,
      sequence: profiles[profile].sequence,
      maxRequestsIncludingPreflight: requests,
    })
  );
  try {
    if (signal?.aborted) throw new Error('Run interrupted before preflight');
    await request('auth.whoami');
    const list = await request('programs.list');
    const programs = list?.programs?.filter(p => typeof p.id === 'string').map(p => p.id) ?? [];
    if (!programs.length)
      throw new Error('No existing programs available; prepare the slot before running traffic.');
    phase = 'workload';
    workloadStartedAt = new Date().toISOString();
    deadline = Date.now() + duration * 1000;
    emit(
      JSON.stringify({
        event: 'workload-started',
        runId,
        workloadStartedAt,
        programCount: programs.length,
      })
    );
    let step = 0;
    const outcomes = await Promise.allSettled(
      Array.from({ length: concurrency }, async () => {
        while (!stopped && !signal?.aborted && Date.now() < deadline && count < requests) {
          // Allocate centrally before awaiting so all workers share one exact request budget and mix.
          const index = step++;
          const procedure = profiles[profile].sequence[index % profiles[profile].sequence.length];
          try {
            await request(procedure, programs[index % programs.length]);
          } catch (error) {
            stopped = true;
            throw error;
          }
          if (count < requests && !stopped && !signal?.aborted) {
            await sleep(Math.min(interval, Math.max(0, deadline - Date.now())), undefined, {
              signal,
            }).catch(error => {
              if (!signal?.aborted) throw error;
            });
          }
        }
      })
    );
    errors.push(...outcomes.filter(r => r.status === 'rejected').map(r => r.reason.message));
  } catch (error) {
    errors.push(error.message);
  }
  const endedAt = new Date().toISOString();
  const summary = {
    event: 'finished',
    runId,
    startedAt,
    workloadStartedAt,
    endedAt,
    slot,
    profile,
    totalRequests: count,
    stopReason: errors.length
      ? 'failure'
      : signal?.aborted
        ? 'interrupted'
        : count >= requests
          ? 'request-limit'
          : 'duration',
    endpoints: [...stats.values()].map(({ timings, ...row }) => {
      timings.sort((a, b) => a - b);
      return {
        ...row,
        requests: timings.length,
        meanClientMs: Math.round(timings.reduce((a, b) => a + b, 0) / timings.length),
        p95ClientMs: Math.round(timings[Math.ceil(timings.length * 0.95) - 1]),
        maxClientMs: Math.round(timings.at(-1)),
      };
    }),
    errors,
  };
  emit(JSON.stringify(summary));
  return summary;
}

async function main() {
  const { values } = parseArgs({
    options: {
      slot: { type: 'string' },
      profile: { type: 'string' },
      duration: { type: 'string' },
      concurrency: { type: 'string' },
      interval: { type: 'string' },
      requests: { type: 'string' },
      'cookie-jar': { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    console.log(
      'node scripts/synthetic-traffic.mjs --slot N [--profile baseline|burst|mixed|attendance] [--duration 60] [--requests 2000] [--concurrency N] [--interval MS] [--cookie-jar PATH]\nRun ss stack login --slot N first. Authenticated read-only loopback traffic. Attendance also requires ads-adm-api and its dependencies. Duration is seconds; interval is pause per worker after each request. Request limit includes two preflight reads.'
    );
    return;
  }
  const options = optionsFrom(values);
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  const result = await runTraffic(options, { signal: controller.signal });
  if (result.errors.length || result.stopReason === 'interrupted') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
