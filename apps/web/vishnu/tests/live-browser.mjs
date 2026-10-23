import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const url = process.env.VISHNU_TEST_URL ?? 'http://127.0.0.1:8930';
let disconnected = true;
let extraNode = false;
let inFlight = 0;
let maxInFlight = 0;
let delayMs = 0;
let health = 'healthy';
let runtimeState;
let requests = 0;
const snapshot = () => ({
  topologyVersion: extraNode ? 'synthetic-test-v2' : 'synthetic-test-v1',
  environment: 'synthetic-dev',
  slot: 0,
  mode: 'live',
  observedAt: new Date().toISOString(),
  observationWindowSeconds: 0,
  systems: [
    ...(extraNode
      ? [
          {
            id: 'worker',
            label: 'Worker',
            band: 'mesh',
            kind: 'service',
            health: 'unknown',
            freshness: 'missing',
            errors: null,
            summary: 'New topology member',
            evidence: [],
          },
        ]
      : []),
    {
      id: 'api',
      label: 'Local API',
      band: 'mesh',
      kind: 'service',
      health,
      runtimeState,
      freshness: 'fresh',
      errors: null,
      summary: 'HTTP health probe',
      evidence: [{ label: 'HTTP probe', description: 'Local endpoint response' }],
    },
    {
      id: 'db',
      label: 'Local database',
      band: 'data',
      kind: 'database',
      health: 'unknown',
      freshness: 'missing',
      errors: null,
      summary: 'Declared dependency',
      evidence: [],
    },
  ],
  relationships: [
    {
      id: 'store',
      source: 'api',
      target: 'db',
      label: 'Declared database connection',
      kind: 'database',
      count: null,
      rate: null,
      latencyMs: null,
      health: 'unknown',
      freshness: 'missing',
      summary: 'Declared, unmeasured connection',
      evidence: [],
    },
  ],
});
try {
  await page.route('**/config.json', route =>
    route.fulfill({ json: { mode: 'live', pollIntervalMs: 3000 } })
  );
  await page.route('**/api/mesh', async route => {
    requests++;
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(resolve => setTimeout(resolve, delayMs));
    try {
      await (disconnected
        ? route.fulfill({ status: 503, body: 'unavailable' })
        : route.fulfill({ json: snapshot() }));
    } finally {
      inFlight--;
    }
  });
  await page.goto(url);
  await page.waitForFunction(() =>
    document
      .querySelector('.live-status')
      ?.textContent.includes('Waiting for mesh observations')
  );
  assert.equal(await page.getByLabel('Fixture scenario').count(), 0);
  assert.equal(await page.locator('.svelte-flow__node').count(), 0);
  disconnected = false;
  await page.locator('.svelte-flow__node').first().waitFor();
  assert.equal(await page.locator('.svelte-flow__node').count(), 2);
  assert.match(await page.locator('.preview-badge').innerText(), /synthetic-dev · slot 0/);
  await page.getByLabel('Find a system').fill('Local API');
  await page.getByRole('button', { name: 'Local API', exact: true }).click();
  await page.getByRole('heading', { name: 'Local API', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Fit selection', exact: true }).click();
  await page.waitForTimeout(400);
  const geometry = () =>
    page.locator('.svelte-flow__node').evaluateAll(nodes => nodes.map(n => n.style.transform));
  const viewport = () => page.locator('.svelte-flow__viewport').evaluate(n => n.style.transform);
  // SvelteFlow's fit animation may round its final transform by a fraction of a pixel.
  const assertViewportStable = async () => {
    const values = text => text.match(/-?\d+(?:\.\d+)?/g).map(Number);
    const current = values(await viewport()), previous = values(beforeViewport);
    assert.equal(current.length, previous.length);
    current.forEach((value, i) => assert.ok(Math.abs(value - previous[i]) < (i === 2 ? .001 : .1), 'Polling must preserve viewport position and zoom'));
  };
  const beforeGeometry = await geometry();
  const beforeViewport = await viewport();
  health = 'critical';
  await page.waitForFunction(
    () => document.querySelector('.status-pill')?.textContent.includes('critical'),
    { timeout: 10000 }
  );
  assert.deepEqual(await geometry(), beforeGeometry);
  await assertViewportStable();
  assert.match(await page.locator('.inspector').innerText(), /Unknown/);
  assert.doesNotMatch(await page.locator('.inspector').innerText(), /Invented fixture/);
  health = 'unknown';
  for (const state of ['not-started', 'stopped']) {
    runtimeState = state;
    await page.waitForFunction(label => [...document.querySelectorAll('.system-node')].some(node =>
      node.textContent.includes('Local API') && node.textContent.includes(label) && !node.classList.contains('critical')
    ), state.replace('-', ' '));
    assert.deepEqual(await geometry(), beforeGeometry);
    await assertViewportStable();
  }
  disconnected = true;
  await page.waitForFunction(
    () => document.querySelector('.status-pill')?.textContent.includes('stale'),
    { timeout: 10000 }
  );
  assert.match(await page.locator('.live-status').innerText(), /last observation, marked stale/);
  assert.equal(await page.locator('.svelte-flow__node').count(), 2);
  disconnected = false;
  await page.waitForFunction(
    () => document.querySelector('.status-pill')?.textContent.includes('fresh'),
    { timeout: 10000 }
  );
  assert.ok(requests >= 5);
  extraNode = true;
  delayMs = 3500;
  await page.waitForFunction(() => document.querySelectorAll('.svelte-flow__node').length === 3);
  assert.equal(maxInFlight, 1, 'Slow responses must not cause overlapping polls');
  assert.notDeepEqual(await geometry(), beforeGeometry);
  await assertViewportStable();
  await page.getByRole('heading', { name: 'Local API', exact: true }).waitFor();
  delayMs = 0;
  await page.goto(`${url}?mode=fixture`);
  await page.getByLabel('Fixture scenario').waitFor();
  assert.match(await page.locator('.preview-badge').innerText(), /Fixture preview/);
  assert.deepEqual(errors, []);
  console.log(
    'Live browser checks passed: slot, real-mode labels, unknowns, stable polling geometry, stale failure, recovery, explicit fixtures.'
  );
} finally {
  await browser.close();
}
