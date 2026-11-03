import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
let meshPolls = 0;
await page.route('**/config.json', route => route.fulfill({ json: {
  mode: 'live', mqEnabled: false, pollIntervalMs: 3000,
} }));
await page.route('**/api/mesh', route => {
  meshPolls++;
  return route.fulfill({ json: {
    topologyVersion: 'stable-reflow-test', mode: 'live', environment: 'synthetic-dev', slot: 3,
    observedAt: new Date().toISOString(), observationWindowSeconds: 900,
    systems: ['a', 'b', 'c'].map(id => ({ id, label: id, band: 'mesh', kind: 'API service',
      health: 'healthy', freshness: 'fresh', errors: null, summary: 'Test', evidence: [] })),
    relationships: [{ id: 'ab', source: 'a', target: 'b', kind: 'http', protocol: 'trpc',
      label: 'A to B', health: 'unknown', freshness: 'missing', count: null,
      rate: null, latencyMs: null, summary: 'Test', evidence: [] }],
  } });
});
await page.route('**/api/datadog', route => {
  const now = Date.now();
  return route.fulfill({ json: {
    version: 1, status: 'connected', observedAt: new Date(now).toISOString(), serverNow: now,
    freshForMs: 10000, scope: { environment: 'synthetic', deployment: 'slot-3', deploymentTag: 'deployment.identifier' },
    appUrl: 'https://app.datadoghq.com', window: { from: now - 900000, to: now },
    thresholds: { hotRate: 10, warningP95Ms: 2500, criticalP95Ms: 5000 },
    services: [], dependencies: [], pathEndpointStatus: 'available',
    pathEndpoints: [{ source: 'a', target: 'b', resource: 'GET /example', observedSpans: 20, p95Ms: 50 }],
  } });
});
const settled = () => page.waitForFunction(() => document.querySelector('.graph-label-layer')?.dataset.layoutMoving === 'false');
async function assertStable(duration) {
  const reflows = await page.evaluate(async duration => {
    const layer = document.querySelector('.graph-label-layer');
    let count = 0;
    const observer = new MutationObserver(() => { if (layer.dataset.layoutMoving === 'true') count++; });
    observer.observe(layer, { attributes: true, attributeFilter: ['data-layout-moving'] });
    await new Promise(resolve => setTimeout(resolve, duration));
    observer.disconnect();
    return count;
  }, duration);
  assert.equal(reflows, 0, 'unchanged focus membership must not restart reflow on clock ticks or telemetry polls');
}
try {
  await page.goto(process.env.VISHNU_TEST_URL ?? 'http://127.0.0.1:11930');
  await page.locator('.graph-label-layer').waitFor();
  await page.getByLabel('Signal view').selectOption('hot');
  await page.waitForFunction(() => document.querySelectorAll('.context-node').length === 1);
  await settled();
  await assertStable(4200);
  assert.ok(meshPolls >= 2, 'test must include a live topology refresh');
  // A real membership change still reflows: the sole measured path expires.
  await page.waitForFunction(() => document.querySelectorAll('.context-node').length === 0, null, { timeout: 15000 });
  await settled();
  await assertStable(2200);
  assert.deepEqual(errors, []);
  console.log('PASS: live Hot paths settle across freshness ticks and topology polls; stale signals reflow once and settle');
} finally {
  await browser.close();
}
