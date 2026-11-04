import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1800, height: 1100 } });
page.setDefaultTimeout(20000);
const errors = [];
page.on('pageerror', e => errors.push(e.message));
const now = Date.now();
const mesh = {
  topologyVersion: 'assistant-test',
  environment: 'synthetic-dev',
  slot: 3,
  mode: 'live',
  observedAt: new Date(now).toISOString(),
  observationWindowSeconds: 900,
  systems: ['iam-api', 'programs-api'].map(id => ({
    id,
    label: id,
    band: 'mesh',
    kind: 'API service',
    health: 'unknown',
    freshness: 'fresh',
    errors: null,
    summary: 'Test fixture',
    evidence: [],
  })),
  relationships: [
    {
      id: 'programs-iam',
      source: 'programs-api',
      target: 'iam-api',
      kind: 'http',
      label: 'Programs → IAM',
      protocol: 'rest',
      count: null,
      rate: null,
      latencyMs: null,
      health: 'unknown',
      freshness: 'missing',
      summary: 'Test',
      evidence: [],
    },
  ],
};
const scope = {
  environment: 'synthetic',
  deployment: 'slot-3',
  deploymentTag: 'deployment.identifier',
};
const data = {
  version: 1,
  status: 'connected',
  scope,
  observedAt: new Date(now).toISOString(),
  serverNow: now,
  freshForMs: 300000,
  appUrl: 'https://app.datadoghq.com',
  window: { from: now - 900000, to: now },
  thresholds: { hotRate: 10, warningP95Ms: 2500, criticalP95Ms: 5000 },
  services: [],
  dependencies: [],
  pathEndpointStatus: 'available',
  pathEndpoints: [
    {
      source: 'programs-api',
      target: 'iam-api',
      resource: 'GET /lookup',
      observedSpans: 25,
      p95Ms: 900,
    },
  ],
  fanoutStatus: 'available',
  fanout: [],
};
const resources = {
  status: 'ready',
  source: 'datadog',
  scope,
  observedAt: new Date(now).toISOString(),
  window: { from: now - 300000, to: now },
  message: 'Browser test fixture',
  instances: [
    {
      system: 'iam-api',
      instance: 'replica-a',
      deployment: 'test-blue',
      cpuCores: 0.9,
      cpuLimitCores: 1,
      cpuPercent: 90,
      memoryBytes: 256e6,
      memoryLimitBytes: 512e6,
      memoryPercent: 50,
      observedAt: new Date(now).toISOString(),
    },
  ],
};
let release;
let delayed = false;
const reply = (route, body) =>
  route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
try {
  await page.route('**/config.json', r =>
    reply(r, { mode: 'live', apiUrl: '/api/mesh', pollIntervalMs: 60000, mqEnabled: false })
  );
  await page.route('**/api/mesh', r => reply(r, mesh));
  await page.route('**/api/datadog', r => reply(r, data));
  await page.route('**/api/resources', r => reply(r, resources));
  await page.route('**/api/assistant/status', r =>
    reply(r, { enabled: true, model: 'test-double', message: 'Browser contract test' })
  );
  await page.route('**/api/assistant/turn', async route => {
    const request = route.request().postDataJSON();
    if (delayed) await new Promise(r => (release = r));
    await route.fulfill({
      contentType: 'application/x-ndjson',
      body: [
        {
          type: 'view',
          contextKey: request.contextKey,
          action: { type: 'show_calls', view: 'slow', system: 'iam-api', direction: 'to' },
        },
        { type: 'text', text: 'Measured sample p95 is 900 ms.\n**saga_dash → `POST /auth/refresh`**\n`<img src=x onerror=alert(1)>`\n<img src=x onerror=alert(1)>' },
        {
          type: 'done',
          model: 'test-double',
          conversationId: '12345678-1234-4123-8123-123456789012',
        },
      ]
        .map(e => JSON.stringify(e) + '\n')
        .join(''),
    });
  });
  await page.goto(process.env.VISHNU_TEST_URL ?? 'http://127.0.0.1:11930');
  const fillsViewport = async () => {
    await page.waitForFunction(() => {
      const canvas = document.querySelector('.graph-canvas')?.getBoundingClientRect();
      return canvas && canvas.height > innerHeight * 0.6 && canvas.bottom > innerHeight - 100;
    });
  };
  await page.setViewportSize({ width: 1708, height: 1209 });
  await fillsViewport();
  await page.getByRole('button', { name: 'Ask Vishnu', exact: true }).click();
  await fillsViewport();
  await page.getByRole('button', { name: 'Find slow calls' }).click();
  await page.getByText('Measured sample p95 is 900 ms.', { exact: false }).waitFor();
  const answer = page.locator('.assistant-messages article').last();
  assert.equal(await answer.locator('strong code').innerText(), 'POST /auth/refresh');
  assert.equal(await answer.locator('img,script,a').count(), 0, 'Assistant content must remain escaped text');
  assert.ok((await answer.innerText()).includes('<img src=x onerror=alert(1)>'));
  assert.equal(await page.getByLabel('Signal view').inputValue(), 'slow');
  assert.equal(await page.getByLabel('Filter by system', { exact: true }).inputValue(), 'iam-api');
  assert.equal(await page.getByLabel('Call direction').inputValue(), 'to');
  await page.getByRole('button', { name: 'Restore previous view' }).click();
  assert.equal(await page.getByLabel('Signal view').inputValue(), 'overview');
  assert.equal(await page.locator('#selection-inspector').count(), 0);
  await fillsViewport();
  delayed = true;
  await page.getByRole('button', { name: 'Find slow calls' }).click();
  await page.getByRole('button', { name: 'Stop', exact: true }).waitFor();
  await page.getByLabel('Signal view').selectOption('fanout');
  await page.waitForFunction(() => true); // yield a browser turn so the bound filter is committed
  while (!release) await new Promise(r => setTimeout(r, 10));
  release();
  await page.getByRole('button', { name: 'Apply suggested view' }).waitFor();
  assert.equal(
    await page.getByLabel('Signal view').inputValue(),
    'fanout',
    'A delayed agent must not overwrite a manual view change'
  );
  await page.getByRole('button', { name: 'Apply suggested view' }).click();
  assert.equal(await page.getByLabel('Signal view').inputValue(), 'slow');
  await page.getByRole('button', { name: 'Resources', exact: true }).click();
  await page.getByRole('region', { name: 'System resources' }).waitFor();
  assert.match(await page.locator('.resources-panel').innerText(), /90\.0%/);
  await page.locator('.resource-pressure').first().waitFor();
  await page.getByRole('button', { name: 'Reset view', exact: true }).click();
  assert.equal(await page.locator('.resources-panel').count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: assistant actions, undo, concurrent manual change protection, resource table/highlight and reset'
  );
} finally {
  await browser.close();
}
