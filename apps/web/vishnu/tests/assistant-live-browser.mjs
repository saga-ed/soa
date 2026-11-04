import assert from 'node:assert/strict';
import { chromium } from 'playwright';

// Explicit opt-in: this test invokes the real Bedrock model and consumes tokens.
if (process.env.VISHNU_LIVE_AGENT !== 'true')
  throw new Error('Set VISHNU_LIVE_AGENT=true to run the real-model demonstration.');
const base = process.env.VISHNU_TEST_URL ?? 'http://127.0.0.1:11930';
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1800, height: 1100 },
  ...(process.env.VISHNU_TEST_STORAGE_STATE
    ? { storageState: process.env.VISHNU_TEST_STORAGE_STATE }
    : {}),
  ...(process.env.VISHNU_TEST_BLUE === 'true'
    ? { extraHTTPHeaders: { 'x-saga-preview-vishnu-api': 'blue' } }
    : {}),
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.setDefaultTimeout(100_000);
const ask = async prompt => {
  await page.getByLabel('What would you like to investigate?').fill(prompt);
  await page.getByRole('button', { name: 'Investigate', exact: true }).click();
  await page.getByRole('button', { name: 'Stop', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Stop', exact: true }).waitFor({ state: 'hidden' });
  assert.equal(
    await page.locator('.assistant-panel [role="alert"]').count(),
    0,
    await page.locator('.assistant-panel').innerText()
  );
  assert.ok((await page.locator('.assistant-messages article').last().innerText()).length > 40);
};
try {
  await page.goto(base);
  await page.getByRole('button', { name: 'Ask Vishnu', exact: true }).click();
  await ask(
    'Show slow calls into iam-api. Explain the measured evidence, units and missing data in under 70 words.'
  );
  assert.equal(await page.getByLabel('Signal view').inputValue(), 'slow');
  assert.equal(await page.getByLabel('Filter by system', { exact: true }).inputValue(), 'iam-api');
  assert.equal(await page.getByLabel('Call direction').inputValue(), 'to');
  await page.screenshot({
    path: process.env.VISHNU_DEMO_SCREENSHOT ?? '/tmp/vishnu-assistant-demo.png',
    fullPage: true,
  });
  await ask('Restore the view I had before this investigation.');
  assert.equal(await page.getByLabel('Signal view').inputValue(), 'overview');
  assert.equal(await page.locator('#selection-inspector').count(), 0);
  await ask(
    'Show resource usage for iam-api. Explain what is known and missing in under 70 words.'
  );
  await page.getByRole('region', { name: 'System resources' }).waitFor();
  assert.equal(await page.locator('.resources-panel select').first().inputValue(), 'iam-api');
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      result: 'passed',
      target: base,
      checks: [
        'real Bedrock streamed response',
        'incoming IAM slow-call filter',
        'model-driven restore without reload',
        'resource evidence and view',
      ],
      errors,
    })
  );
} finally {
  await browser.close();
}
