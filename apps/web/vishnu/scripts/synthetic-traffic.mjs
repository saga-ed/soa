import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

// Deliberately fixed loopback targets and GET procedures: this driver cannot target hosted data.
const { values } = parseArgs({ options: {
  slot: { type: 'string' }, duration: { type: 'string', default: '60' },
  concurrency: { type: 'string', default: '1' }, interval: { type: 'string', default: '1000' },
  'cookie-jar': { type: 'string' }, help: { type: 'boolean', default: false },
} });
if (values.help) {
  console.log('node scripts/synthetic-traffic.mjs --slot N [--duration 60] [--concurrency 1] [--interval 1000] [--cookie-jar PATH]\nRun ss stack login --slot N first. Read-only IAM/programs/scheduling traffic; duration in seconds, interval in ms per worker.');
  process.exit(0);
}
function integer(name, value, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer ${min}..${max}`);
  return n;
}
const slot = integer('slot', values.slot, 0, 9);
const duration = integer('duration', values.duration, 1, 600);
const concurrency = integer('concurrency', values.concurrency, 1, 8);
const interval = integer('interval', values.interval, 100, 10000);
const state = `/tmp/sds-synthetic${slot ? `-s${slot}` : ''}`;
const jar = await readFile(values['cookie-jar'] ?? `${state}/cookies.txt`, 'utf8');
const cookies = jar.split('\n').filter(line => line.startsWith('#HttpOnly_') || (line && !line.startsWith('#')))
  .map(line => line.replace(/^#HttpOnly_/, '').split('\t'))
  .filter(p => p.length === 7 && ['localhost', '127.0.0.1'].includes(p[0]) && p[3] !== 'TRUE' && (p[4] === '0' || Number(p[4]) * 1000 > Date.now()))
  .map(p => `${p[5]}=${p[6]}`).join('; ');
if (!cookies.includes('iam_session=')) throw new Error(`No valid local session; run ss stack login --slot ${slot}`);
const stats = new Map();
let stopped = false;
process.once('SIGINT', () => { stopped = true; });
process.once('SIGTERM', () => { stopped = true; });
async function request(port, procedure, input) {
  const url = new URL(`/trpc/${procedure}`, `http://localhost:${port + slot * 1000}`);
  if (input !== undefined) url.searchParams.set('input', JSON.stringify(input));
  const start = performance.now();
  let status = 0;
  let succeeded = false;
  try {
    const response = await fetch(url, { headers: { cookie: cookies }, redirect: 'error', signal: AbortSignal.timeout(10000) });
    status = response.status;
    if (!response.ok) throw new Error(`${procedure}: HTTP ${status}`);
    const body = await response.json();
    if (body.error || !body.result) throw new Error(`${procedure}: invalid tRPC response`);
    succeeded = true;
    return body.result.data;
  } finally {
    const row = stats.get(procedure) ?? { requests: 0, failures: 0, totalMs: 0, maxMs: 0, statuses: {} };
    const ms = performance.now() - start;
    row.requests++; row.failures += succeeded ? 0 : 1;
    row.totalMs += ms; row.maxMs = Math.max(row.maxMs, ms);
    row.statuses[status] = (row.statuses[status] ?? 0) + 1;
    stats.set(procedure, row);
  }
}
const startedAt = new Date().toISOString();
await request(3010, 'auth.whoami');
const list = await request(3006, 'programs.list', { page: 1, limit: 5 });
const programs = list?.programs?.filter(p => typeof p.id === 'string').map(p => p.id) ?? [];
if (!programs.length) throw new Error('No existing programs available. Supply an already prepared slot; this driver does not seed data.');
const deadline = Date.now() + duration * 1000;
console.log(JSON.stringify({ event: 'started', startedAt, slot, duration, concurrency, interval, programCount: programs.length, procedures: ['auth.whoami','programs.list','programs.get','schedules.get'] }));
const outcomes = await Promise.allSettled(Array.from({ length: concurrency }, async (_, worker) => {
  let step = worker;
  while (!stopped && Date.now() < deadline) {
    const programId = programs[step % programs.length];
    try {
      switch (step % 4) {
        case 0: await request(3010, 'auth.whoami'); break;
        case 1: await request(3006, 'programs.list', { page: 1, limit: 5 }); break;
        case 2: await request(3006, 'programs.get', { id: programId }); break;
        case 3: await request(3008, 'schedules.get', { programId }); break;
      }
    } catch (error) { stopped = true; throw error; }
    step++;
    await delay(Math.min(interval, Math.max(0, deadline - Date.now())));
  }
}));
console.log(JSON.stringify({ event: 'finished', startedAt, endedAt: new Date().toISOString(), slot,
  endpoints: [...stats].map(([procedure, s]) => ({ procedure, requests: s.requests, failures: s.failures, meanClientMs: Math.round(s.totalMs / s.requests), maxClientMs: Math.round(s.maxMs), statuses: s.statuses })),
  errors: outcomes.filter(r => r.status === 'rejected').map(r => r.reason.message),
}));
if (outcomes.some(r => r.status === 'rejected')) process.exitCode = 1;
