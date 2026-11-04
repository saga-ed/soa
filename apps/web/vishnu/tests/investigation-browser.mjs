import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.setDefaultTimeout(15000);
const errors = [];
page.on('pageerror', e => errors.push(e.message));
const base = process.env.VISHNU_TEST_URL ?? 'http://127.0.0.1:11930';
let variant = 'normal';
const now = Date.now();
const mesh = {
  topologyVersion: 'investigation-test',
  environment: 'synthetic-dev',
  slot: 3,
  mode: 'live',
  observedAt: new Date(now).toISOString(),
  observationWindowSeconds: 900,
  systems: ['a', 'b', 'c', 'quiet'].map(id => ({
    id,
    label: id,
    band: 'mesh',
    kind: 'API service',
    health: 'unknown',
    freshness: 'fresh',
    errors: null,
    summary: 'Test',
    evidence: [],
  })),
  relationships: [
    ['ab', 'a', 'b', 'http'],
    ['ca', 'c', 'a', 'http'],
    ['db', 'a', 'b', 'database'],
  ].map(([id, source, target, kind]) => ({
    id,
    source,
    target,
    kind,
    label: id,
    protocol: 'rest',
    count: null,
    rate: null,
    latencyMs: null,
    health: 'unknown',
    freshness: 'missing',
    summary: 'Test',
    evidence: [],
  })),
};
const payload = () => ({
  version: 1,
  status: 'connected',
  observedAt: new Date(variant === 'stale' ? now - 900000 : now).toISOString(),
  serverNow: now,
  freshForMs: 300000,
  scope: {
    environment: 'synthetic',
    deployment: variant === 'scope' ? 'slot-0' : 'slot-3',
    deploymentTag: 'deployment.identifier',
  },
  appUrl: 'https://app.datadoghq.com',
  window: { from: now - 900000, to: now },
  thresholds: { hotRate: 10, warningP95Ms: 2500, criticalP95Ms: 5000 },
  services: [],
  dependencies: [],
  pathEndpointStatus: 'available',
  pathEndpoints: [
    { source: 'a', target: 'b', resource: 'GET /shared', observedSpans: 6, p95Ms: 900 },
    { source: 'c', target: 'a', resource: 'GET /shared', observedSpans: 12, p95Ms: 100 },
    { source: 'a', target: 'b', resource: 'GET /sample-only', observedSpans: 20, p95Ms: null },
  ],
  pathRateSource: 'application-counter',
  pathRateStatus: 'available',
  pathRateObservedAt: new Date(now).toISOString(),
  pathRateFreshForMs: 180000,
  pathRateWindow: { from: now - 120000, to: variant === 'stale' ? now - 900000 : now - 60000 },
  pathRates:
    variant === 'sample-only'
      ? []
      : [
          {
            source: 'a',
            target: 'b',
            resource: 'GET /shared',
            count: 120,
            rate: { at: now - 60000, value: 2 },
          },
          {
            source: 'a',
            target: 'b',
            resource: 'GET /idle',
            count: 0,
            rate: { at: now - 60000, value: 0 },
          },
        ],
  fanoutStatus: 'available',
  fanoutCoverage: {
    observedAt: new Date(now).toISOString(),
    requestedTraces: 3,
    retrievedTraces: 3,
    usableTraces: 2,
    rejectedTraces: 1,
    limited: true,
    basis: 'recent-retained-trace-sample',
  },
  fanout: [
    {
      source: 'a',
      target: 'b',
      resource: 'GET /shared',
      parentResource: 'GET /parent-one',
      sampledParents: 2,
      observedCalls: 10,
      meanCallsPerParent: 5,
      maxCallsPerParent: 8,
      traceIds: [],
    },
    {
      source: 'a',
      target: 'b',
      resource: 'GET /shared',
      parentResource: 'GET /parent-two',
      sampledParents: 4,
      observedCalls: 8,
      meanCallsPerParent: 2,
      maxCallsPerParent: 3,
      traceIds: [],
    },
  ],
});
await page.route('**/config.json', r => r.fulfill({ json: { mode: 'live', mqEnabled: false } }));
await page.route('**/api/mesh', r => r.fulfill({ json: mesh }));
await page.route('**/api/datadog', r =>
  variant === 'failed'
    ? r.fulfill({ status: 503, body: 'unavailable' })
    : r.fulfill({ json: payload() })
);
const button = name => page.getByRole('button', { name, exact: true });
const table = page.locator('.investigation-table');
const rows = table.locator('tbody tr[data-call-key]');
const rowKeys = () => rows.evaluateAll(rs => rs.map(r => r.dataset.callKey));
async function open() {
  await page.goto(base);
  await page.locator('.svelte-flow__node').first().waitFor();
  await button('Show inspector').click();
  await button('Table').click();
  await table.waitFor();
}
try {
  await open();
  await page.waitForFunction(
    () => document.querySelectorAll('.investigation-table tbody tr[data-call-key]').length === 4
  );
  await page.waitForTimeout(900);
  assert.deepEqual(await page.evaluate(() => {
    const canvas = document.querySelector('.graph-canvas').getBoundingClientRect();
    return [...document.querySelectorAll('.svelte-flow__node')].filter(node => {
      const r = node.getBoundingClientRect();
      return r.left < canvas.left - 2 || r.right > canvas.right + 2 || r.top < canvas.top - 2 || r.bottom > canvas.bottom + 2;
    }).map(node => node.dataset.id);
  }), [], 'Expanding the table must fit the mesh to its new canvas');
  await page.screenshot({ path: '/tmp/vishnu-investigation-hot.png', fullPage: true });
  assert.equal(await table.locator('th[aria-sort="descending"]').innerText(), 'Requests/sec ↓');
  assert.match(await rows.first().innerText(), /GET \/shared/);
  assert.match(await rows.nth(1).innerText(), /GET \/idle/);
  await page.getByLabel('Filter by system', { exact: true }).selectOption('a');
  await page.getByLabel('Call direction').selectOption('from');
  assert.equal(await rows.count(), 3);
  const before = await rowKeys();
  await rows.first().getByRole('button').click();
  await page.getByRole('region', { name: 'Selected call evidence', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Filter by system', { exact: true }).inputValue(), 'a');
  assert.deepEqual(await rowKeys(), before);
  assert.equal(
    await page
      .locator('.svelte-flow__edge[data-id="ab"]')
      .getAttribute('class')
      .then(c => c.includes('selected')),
    true
  );
  await button('Details').click();
  await page.getByRole('heading', { name: 'ab', exact: true }).waitFor();
  await button('Table').click();
  assert.deepEqual(await rowKeys(), before);
  await button('Hide inspector').click();
  await button('Show inspector').click();
  assert.equal(await page.getByLabel('Call direction').inputValue(), 'from');
  assert.deepEqual(await rowKeys(), before);
  await button('Close call evidence').click();
  assert.deepEqual(await rowKeys(), before);
  assert.ok((await page.locator('.svelte-flow__node[data-id="a"]').getAttribute('class')).includes('selected'), 'Closing call evidence restores the filtered system highlight');
  await page.getByLabel('Call direction').selectOption('to');
  assert.equal(await rows.count(), 1);
  await button('Clear filter').click();
  assert.equal(await rows.count(), 4);
  await page.getByLabel('Investigate', { exact: true }).selectOption('slow');
  assert.equal(await page.getByLabel('Signal view').inputValue(), 'slow');
  assert.equal(await table.locator('th[aria-sort="descending"]').innerText(), 'Sample p95 (ms) ↓');
  await table.getByRole('button', { name: 'Sample p95 (ms) ↓', exact: true }).click();
  assert.match(await rows.first().innerText(), /100/);
  assert.equal(await rows.last().locator('td').nth(5).innerText(), '—');
  await page.getByLabel('Signal view').selectOption('fanout');
  assert.equal(await rows.count(), 2);
  assert.match(await rows.first().innerText(), /parent-one/);
  await table.getByRole('button', { name: 'Sampled parents', exact: true }).click();
  assert.match(await rows.first().innerText(), /parent-two/);
  await rows.first().getByRole('button').focus();
  await page.keyboard.press('Enter');
  assert.match(
    await page.getByRole('region', { name: 'Selected call evidence', exact: true }).innerText(),
    /Parent: GET \/parent-two/
  );
  await page.waitForTimeout(700);
  await page.screenshot({ path: '/tmp/vishnu-investigation-fanout.png', fullPage: true });

  // Direct mesh clicks and accessible search use exactly the same filter state.
  await page.getByLabel('Signal view').selectOption('overview');
  await button('Fit mesh').click();
  await page.waitForTimeout(700);
  await page.locator('.svelte-flow__node[data-id="c"]').click();
  assert.equal(await page.getByLabel('Filter by system', { exact: true }).inputValue(), 'c');
  await page.getByLabel('Call direction').selectOption('both');
  assert.equal(await rows.count(), 1);
  await page.getByLabel('Find a system').fill('quiet');
  await page.locator('.search-results button').click();
  assert.equal(await rows.count(), 0);
  assert.match(await table.innerText(), /No current calls/);
  await button('Browse as list').click();
  await page.locator('#mesh-list button').filter({ hasText: /^ab/ }).click();
  assert.match(await page.locator('.investigation-path').innerText(), /a → b/);
  assert.equal(await rows.count(), 3);
  await page.locator('#mesh-list button').filter({ hasText: /^db/ }).click();
  assert.equal(await rows.count(), 0);
  assert.match(
    await page.locator('.investigation-path').innerText(),
    /unavailable for this connection type/
  );
  await button('Hide list').click();
  await button('Clear filter').click();
  for (const width of [1366, 820]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      'No document horizontal overflow'
    );
    await button('Collapse table').click();
    await button('Expand table').click();
    await page.screenshot({ path: `/tmp/vishnu-investigation-${width}.png`, fullPage: true });
  }
  await button('Reset view').click();
  await button('Show inspector').click();
  assert.equal(await button('Details').getAttribute('aria-pressed'), 'true');
  await button('Table').click();
  assert.equal(await page.getByLabel('Filter by system', { exact: true }).inputValue(), '');
  assert.equal(await page.getByLabel('Call direction').inputValue(), 'both');
  for (variant of ['sample-only', 'stale', 'scope', 'failed']) {
    await open();
    if (variant === 'sample-only') {
      assert.equal(await rows.count(), 3);
      assert.match(await rows.first().innerText(), /sample-only/);
      assert.match(
        await page.getByRole('region', { name: 'Call offenders', exact: true }).innerText(),
        /not total traffic/
      );
    } else {
      assert.equal(await rows.count(), 0);
      assert.match(await table.innerText(), /No current calls/);
    }
  }
  assert.deepEqual(errors, []);
  console.log(
    'PASS: column sorting, zeros/unknowns, bidirectional system and path filters, row evidence/highlight, persistent list state, fan-out parents, responsive expansion, reset, stale/scope/error handling'
  );
} catch (error) {
  console.error({ errors, body: await page.locator('body').innerText() });
  await page.screenshot({ path: '/tmp/vishnu-investigation-failure.png', fullPage: true });
  throw error;
} finally {
  await browser.close();
}
