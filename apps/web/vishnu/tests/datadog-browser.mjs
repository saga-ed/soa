import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base = process.env.VISHNU_TEST_URL ?? 'http://127.0.0.1:11930';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
const now = Date.now();
let variant = 'connected';
const value = () => ({
  version: 1,
  status: variant === 'unconfigured' ? 'unconfigured' : 'connected',
  message: 'Browser-only test observations',
  observedAt: new Date(variant === 'stale' ? now - 600000 : now).toISOString(),
  serverNow: now,
  freshForMs: 180000,
  scope: {
    environment: 'synthetic',
    deployment: variant === 'wrong-scope' ? 'slot-0' : 'slot-3',
    deploymentTag: 'deployment.identifier',
  },
  appUrl: 'https://app.datadoghq.com',
  window: { from: now - 900000, to: now },
  thresholds: { hotRate: 10, warningP95Ms: 2500, criticalP95Ms: 5000 },
  services:
    variant === 'unconfigured'
      ? []
      : [
          {
            service: 'programs-api',
            rate: { at: now, value: 20 },
            p95Ms: { at: now, value: 3000 },
            errorRate: { at: now, value: 0 },
            previousP95Ms: 1000,
            monitors: [],
          },
        ],
  dependencies: [{ source: 'programs-api', target: 'scheduling-api' }],
});
// Keep this overlay test independent of a running synthetic stack.
await page.route('**/config.json', r => r.fulfill({ json: { mode:'live', mqEnabled:false } }));
await page.route('**/api/mesh', r => r.fulfill({ json: {
  topologyVersion:'datadog-browser-test', environment:'synthetic-dev', slot:3, mode:'live',
  observedAt:new Date(now).toISOString(), observationWindowSeconds:900,
  systems:['programs-api','scheduling-api'].map(id=>({id,label:id,band:'mesh',kind:'API service',health:'unknown',freshness:'missing',errors:null,summary:'Browser test declaration',evidence:[]})),
  relationships:[{id:'test-programs-scheduling',source:'programs-api',target:'scheduling-api',label:'Browser test path',kind:'http',protocol:'trpc',count:null,rate:null,latencyMs:null,health:'unknown',freshness:'missing',summary:'Browser test declaration',evidence:[]}]
} }));
await page.route('**/api/datadog', r =>
  variant === 'failure'
    ? r.fulfill({ status: 503, body: 'unavailable' })
    : r.fulfill({ json: value() })
);
try {
  await page.goto(base);
  await page.getByLabel('Signal view').waitFor();
  await page.locator('.apm-badge').first().waitFor();
  await page.getByLabel('Reflow signal focus').uncheck();
  const node = page.locator('.svelte-flow__node[data-id="programs-api"]');
  const geometry = await page
    .locator('.svelte-flow__node')
    .evaluateAll(ns => ns.map(n => [n.dataset.id, n.style.transform]));
  const paths = await page.locator('.svelte-flow__edge').count();
  await page.getByLabel('Signal view').selectOption('slow');
  assert.equal(await page.locator('.svelte-flow__edge').count(), paths);
  assert.deepEqual(
    await page
      .locator('.svelte-flow__node')
      .evaluateAll(ns => ns.map(n => [n.dataset.id, n.style.transform])),
    geometry
  );
  assert.equal(
    await node.locator('.system-node').evaluate(n => n.classList.contains('dimmed')),
    false
  );
  await page.getByRole('button', { name: 'Browse as list', exact: true }).click();
  await page
    .locator('#mesh-list')
    .getByRole('button')
    .filter({ hasText: 'programs-api' })
    .first()
    .click();
  const inspector = page.getByLabel('Datadog observations');
  await inspector.waitFor();
  assert.match(await inspector.innerText(), /3,000 ms/);
  const href = await inspector
    .getByRole('link', { name: 'Open service traces in Datadog' })
    .getAttribute('href');
  assert.equal(new URL(href).origin, 'https://app.datadoghq.com');
  assert.match(new URL(href).searchParams.get('query'), /slot-3/);
  await page.screenshot({ path: '/tmp/vishnu-dd-inspector.png' });
  for (const state of ['wrong-scope', 'stale', 'failure', 'unconfigured']) {
    variant = state;
    await Promise.all([page.waitForResponse(r => r.url().endsWith('/api/datadog')), page.reload()]);
    await page.getByLabel('Signal view').waitFor();
    assert.equal(
      await page.locator('.apm-badge').count(),
      0,
      `${state} must not display active metrics`
    );
  }
  assert.deepEqual(errors, []);
  console.log(
    'PASS: Datadog service overlay, scope/freshness/failure, links, stable geometry and emphasis views'
  );
} finally {
  await browser.close();
}
