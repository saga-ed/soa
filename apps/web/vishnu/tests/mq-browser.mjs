import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const url = process.env.VISHNU_TEST_URL ?? 'http://127.0.0.1:8930';
const response = await fetch(new URL('/api/event-stats', url));
assert.equal(response.status, 200);
const original = await response.json();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
let payload = structuredClone(original),
  fail = false;
await page.route('**/api/event-stats', route =>
  fail ? route.fulfill({ status: 503, body: 'unavailable' }) : route.fulfill({ json: payload })
);
const waitText = async text =>
  page.waitForFunction(
    text => document.querySelector('.inspector .mq-stats')?.textContent.includes(text),
    text
  );
try {
  await page.goto(url);
  await page.locator('.system-node').first().waitFor();
  for (const id of ['sessions-api', 'connect-web', 'coach-web', 'saga-dash'])
    assert.equal(await page.locator(`.svelte-flow__node[data-id="${id}"]`).count(), 1);
  assert.match(
    await page.locator('.svelte-flow__node[data-id="connect-web"]').innerText(),
    /Connectv3/
  );
  assert.match(await page.locator('.svelte-flow__node[data-id="coach-web"]').innerText(), /Coach/);
  const api = page.locator('.svelte-flow__node[data-id="programs-api"] .system-node');
  await api.click();
  await page.getByRole('heading', { name: 'programs-api', exact: true }).waitFor();
  await waitText('reporting instance');
  await page.getByRole('button', { name: 'Fit selection', exact: true }).click();
  await page.waitForTimeout(500);
  const geometry = () =>
    page.locator('.svelte-flow__node').evaluateAll(nodes => nodes.map(n => n.style.transform));
  const viewport = () =>
    page.locator('.svelte-flow__viewport').evaluate(node => node.style.transform);
  const before = await geometry(),
    transform = await viewport();
  const badge = page.getByRole('button', {
    name: 'Inspect event bus participation for programs-api',
    exact: true,
  });
  await badge.hover();
  const preview = page.getByRole('dialog', { name: 'MQ statistics preview' });
  await preview.waitFor();
  assert.match(await preview.innerText(), /Publish accepted/);
  await preview.hover();
  await page.waitForTimeout(300);
  assert.equal(await preview.isVisible(), true);
  await preview.getByRole('button', { name: 'Open inspector' }).click();
  await page.getByRole('heading', { name: 'programs-api', exact: true }).waitFor();
  await badge.focus();
  await preview.waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await preview.count(), 0);
  // A fresh idle counter is rendered as a measured zero.
  for (const source of payload.sources)
    for (const row of source.report.streams)
      if (row.stream.role === 'producer') row.counters.publishAccepted = 0;
  await page.waitForFunction(
    () => document.querySelector('.inspector .mq-stats tbody tr td')?.textContent === '0'
  );
  payload.sources = [];
  await waitText('No reports');
  payload = structuredClone(original);
  for (const source of payload.sources) source.freshness = 'stale';
  await waitText('Reports have expired');
  fail = true;
  await waitText('Statistics API unavailable');
  fail = false;
  payload = structuredClone(original);
  await waitText('reporting instance');
  assert.deepEqual(await geometry(), before);
  assert.equal(await viewport(), transform);
  await page.getByRole('heading', { name: 'programs-api', exact: true }).waitFor();
  // No scope mixing, even if a cached response belongs to another slot.
  payload.scope.deployment = 'slot-0';
  await waitText('No reports');
  assert.deepEqual(errors, []);
  console.log(
    'MQ browser checks passed: declared apps/APIs, node selection, hover/focus/Escape, measured zero, no reports, stale/API failure/recovery, scope isolation and stable geometry/selection.'
  );
} finally {
  await browser.close();
}
