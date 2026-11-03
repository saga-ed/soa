import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

const payloads = [];
let traceExports = 0;
const intake = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (req.url === '/v1/metrics') payloads.push(JSON.parse(Buffer.concat(chunks).toString()));
  if (req.url === '/v1/traces') traceExports++;
  res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
});
let retry = 0;
const server = createServer((req, res) => {
  const mode = new URL(req.url, 'http://test').searchParams.get('mode');
  if (mode === 'retry' && retry++ === 0) {
    res.writeHead(503).end('retry');
    return;
  }
  if (mode === 'abort') {
    res.writeHead(200).write('partial');
    return;
  }
  if (mode === 'truncated') {
    res.writeHead(200, { 'content-length': '200' });
    res.write('partial');
    setImmediate(() => res.destroy());
    return;
  }
  res.writeHead(200).end('ok');
});
const unavailable = createServer();
for (const instance of [intake, server, unavailable]) {
  instance.listen(0, '127.0.0.1');
  await once(instance, 'listening');
}
const origin = `http://127.0.0.1:${server.address().port}`;
const unavailableOrigin = `http://127.0.0.1:${unavailable.address().port}`;
await new Promise(resolve => unavailable.close(resolve));
process.env.OTEL_TRACES_SAMPLER = 'always_off';
process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${intake.address().port}`;
process.env.OTEL_METRIC_EXPORT_INTERVAL = '1000';
process.env.OTEL_RESOURCE_ATTRIBUTES =
  'deployment.environment.name=synthetic,deployment.environment=synthetic,deployment.identifier=slot-3,synthetic.machine=telemetry-test,synthetic.slot=3';
delete process.env.OTEL_TRACES_DISABLED;
delete process.env.OTEL_METRICS_EXPORTER;
delete process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
delete process.env.ECS_CONTAINER_METADATA_URI_V4;
process.env.SAGA_HTTP_METRIC_PEERS = JSON.stringify([
  {
    service: 'iam-api',
    origins: [origin, unavailableOrigin],
    routes: [
      { path: '/trpc/personas.getMyPermissions', methods: ['GET'] },
      { path: '/people/:id', methods: ['GET'] },
    ],
  },
]);
const { initTracing } = await import(process.argv[2]);
const handle = initTracing('programs-api');
// Require after bootstrap so the actual native HTTP module is instrumented.
const http = createRequire(import.meta.url)('node:http');
const native = (url, abort = false) =>
  new Promise(resolve => {
    const req = http.get(url, response => {
      response.on('error', () => resolve('error'));
      response.on('end', () => resolve(response.statusCode));
      response.resume();
      if (abort) {
        const error = new Error('aborted');
        error.name = 'AbortError';
        error.code = 'ABORT_ERR';
        req.destroy(error);
      }
    });
    req.on('error', () => resolve('error'));
  });
const fetchRead = async url => {
  try {
    const response = await fetch(url);
    await response.text();
    return response.status;
  } catch {
    return 'error';
  }
};
async function waitForExports(count) {
  const deadline = Date.now() + 10000;
  while (payloads.length < count && Date.now() < deadline) await delay(25);
  if (payloads.length < count) throw new Error('OTLP export did not arrive');
}
await waitForExports(1);
const path = '/trpc/personas.getMyPermissions';
await Promise.all(Array.from({ length: 6 }, () => native(origin + path + '?private=student-id')));
await Promise.all(
  Array.from({ length: 6 }, () => fetchRead(origin + path + '?private=student-id'))
);
// The observer must not change OTel's automatic draining when no callback is supplied.
await new Promise((resolve, reject) => {
  const req = http.get(origin + path);
  req.on('close', resolve);
  req.on('error', reject);
});
const retryFirst = await native(origin + path + '?mode=retry');
if (retryFirst === 503) await native(origin + path + '?mode=retry');
await native(unavailableOrigin + path);
await fetchRead(unavailableOrigin + path);
await native(origin + path + '?mode=abort', true);
const controller = new AbortController();
const partial = await fetch(origin + path + '?mode=abort', { signal: controller.signal });
controller.abort();
await partial.text().catch(() => {});
await native(origin + path + '?mode=truncated');
await Promise.all([
  native(origin + '/people/12345?secret=x'),
  fetchRead(origin + '/people/another-private-value?secret=y'),
]);
await Promise.all([native(origin + '/unlisted/private'), fetchRead(origin + '/unlisted/private')]);
// Collect completed workload followed by an explicitly observed idle interval.
const afterWork = payloads.length;
await waitForExports(afterWork + 2);
await handle.shutdown();
server.closeAllConnections();
intake.closeAllConnections();
await Promise.all([
  new Promise(resolve => server.close(resolve)),
  new Promise(resolve => intake.close(resolve)),
]);
const attributes = pairs =>
  Object.fromEntries(
    (pairs ?? []).map(p => [p.key, p.value.stringValue ?? p.value.intValue ?? p.value.doubleValue])
  );
const exports = payloads.map(payload =>
  (payload.resourceMetrics ?? []).flatMap(resource =>
    (resource.scopeMetrics ?? []).flatMap(scope =>
      scope.metrics
        .filter(m => m.name.startsWith('saga.http.client.'))
        .map(metric => ({
          name: metric.name,
          resource: attributes(resource.resource.attributes),
          temporality: metric.sum?.aggregationTemporality,
          points: (metric.sum?.dataPoints ?? metric.gauge?.dataPoints ?? []).map(point => ({
            attributes: attributes(point.attributes),
            value: Number(point.asDouble ?? point.asInt),
          })),
        }))
    )
  )
);
console.log(JSON.stringify({ traceExports, exports }));
