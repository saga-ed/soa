import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const url = process.env.VISHNU_TEST_URL ?? 'http://127.0.0.1:8930';
const slot = Number(process.env.VISHNU_TEST_SLOT ?? 0);
const snapshot = await fetch(new URL('/api/mesh', url)).then(r => {
  assert.equal(r.status, 200);
  return r.json();
});
assert.equal(snapshot.mode, 'live');
assert.equal(snapshot.slot, slot);
for (const id of ['iam-api', 'saga-dash', 'vishnu', 'infra:postgres', 'infra:rabbitmq']) {
  assert.equal(
    snapshot.systems.find(s => s.id === id)?.health,
    'healthy',
    `${id} must be reachable`
  );
}
assert.ok(snapshot.relationships.every(r => r.rate === null && r.count === null));

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
const observations = [];
page.on('pageerror', error => errors.push(error.message));
page.on('response', async response => {
  if (new URL(response.url()).pathname === '/api/mesh' && response.ok()) {
    observations.push((await response.json()).observedAt);
  }
});
try {
  await page.goto(url);
  await page.locator('.svelte-flow__edge').first().waitFor();
  assert.match(await page.locator('.preview-badge').innerText(), /synthetic-dev/);
  assert.equal(await page.locator('.svelte-flow__node').count(), snapshot.systems.length);
  assert.equal(await page.locator('.svelte-flow__edge').count(), snapshot.relationships.filter(r => r.kind !== 'event').length);
  await page.getByLabel('Find a system').fill('iam-api');
  await page.locator('.search-results').getByRole('button', { name: 'iam-api', exact: true }).click();
  await page.getByRole('heading', { name: 'iam-api', exact: true }).waitFor();
  assert.match(await page.locator('.inspector').innerText(), /HTTP health probe/);
  assert.match(await page.locator('.inspector').innerText(), /Unknown/);
  await page.getByRole('button', { name: 'Fit selection', exact: true }).click();
  const geometry = await page
    .locator('.svelte-flow__node')
    .evaluateAll(nodes => nodes.map(n => n.style.transform));
  const viewport = await page.locator('.svelte-flow__viewport').evaluate(n => n.style.transform);
  // Observe a real subsequent probe, without changing or stopping any service.
  await page.waitForTimeout(16500);
  assert.ok(new Set(observations).size >= 2, 'Real telemetry must refresh');
  assert.deepEqual(
    await page
      .locator('.svelte-flow__node')
      .evaluateAll(nodes => nodes.map(n => n.style.transform)),
    geometry
  );
  assert.equal(
    await page.locator('.svelte-flow__viewport').evaluate(n => n.style.transform),
    viewport
  );
  await page.getByLabel('Find a system').fill('rabbitmq');
  await page.getByRole('button', { name: 'rabbitmq', exact: true }).click();
  await page.getByRole('button', { name: 'Show relationship details' }).click();
  assert.ok((await page.locator('.inspector .relationship-list button').count()) > 0);
  assert.deepEqual(errors, []);
  console.log(
    `Synthetic-dev slot ${slot} verified: ${snapshot.systems.length} systems, ${snapshot.relationships.length} declared connections, real probe refresh, stable selection and layout.`
  );
} finally {
  await browser.close();
}
