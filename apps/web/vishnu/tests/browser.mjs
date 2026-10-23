import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const url = process.env.VISHNU_TEST_URL ?? 'http://127.0.0.1:8930';

try {
  await page.goto(url);
  await page.locator('.svelte-flow__node').first().waitFor();
  assert.equal(await page.locator('.svelte-flow__node').count(), 9);
  assert.equal(await page.locator('.svelte-flow__edge').count(), 8);
  await page.waitForFunction(() => document.querySelector('.svelte-flow__edge-wrapper')?.getBoundingClientRect().height > 0);
  assert.ok(
    await page
      .locator('.svelte-flow__edge-wrapper')
      .first()
      .evaluate(svg => svg.getBoundingClientRect().height > 0),
    'Edge SVG must have a nonzero viewport, not just paths present in the DOM'
  );
  assert.match(await page.locator('body').innerText(), /Fixture preview/);
  assert.match(
    await page.locator('body').evaluate(body => getComputedStyle(body).fontFamily),
    /Montserrat Variable/
  );

  assert.equal(await page.locator('.bus-panel').count(), 1);
  assert.equal(await page.locator('.bus-participant').count(), 3);
  await page.locator('.bus-participant button').first().click();
  await page.getByRole('heading', { name: 'MQ activity', exact: true }).waitFor();
  await page.locator('.bus-badge').first().click();
  await page.getByRole('heading', { name: 'MQ activity', exact: true }).waitFor();
  await page.getByLabel('Clear selection').click();

  const geometry = () =>
    page
      .locator('.svelte-flow__node')
      .evaluateAll(nodes =>
        nodes.map(node => [node.getAttribute('data-id'), node.style.transform])
      );
  const viewport = () => page.locator('.svelte-flow__viewport').evaluate(el => el.style.transform);
  const initialGeometry = await geometry();

  // Search provides a keyboard-accessible alternative to locating a small node.
  await page.getByLabel('Find a system').fill('Scheduling');
  await page.locator('.search-results').getByRole('button', { name: 'Scheduling API', exact: true }).click();
  await page.getByRole('heading', { name: 'Scheduling API', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Fit selection', exact: true }).click();
  const selectedViewport = await viewport();
  await page.getByLabel('Fixture scenario').selectOption('missing');
  await page.waitForFunction(() =>
    document.querySelector('.status-pill')?.textContent?.includes('unknown')
  );
  await page.waitForFunction(() => document.querySelectorAll('.svelte-flow__edge').length === 8);
  assert.deepEqual(await geometry(), initialGeometry);
  assert.equal(await viewport(), selectedViewport);
  assert.match(await page.locator('.inspector').innerText(), /Unknown/);
  assert.equal(await page.locator('.svelte-flow__edge').count(), 8);

  // A known zero must remain a numeric reading rather than becoming unknown.
  await page.getByLabel('Fixture scenario').selectOption('overview');
  await page.getByLabel('Clear selection').click();
  await page.getByLabel('Find a system').fill('Staff');
  await page.getByRole('button', { name: 'Staff console', exact: true }).click();
  await page.getByRole('button', { name: 'Show relationship details' }).click();
  await page.getByRole('button', { name: /Program inspection/ }).click();
  assert.match(await page.locator('.inspector').innerText(), /0\/s/);

  await page.getByLabel('Clear selection').click();
  await page.getByRole('button', { name: 'Fit mesh', exact: true }).click();
  const iam = page.locator('.svelte-flow__node[data-id="iam"]');
  await iam.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: 'IAM API', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Fit mesh', exact: true }).click();
  const pathPoint = await page
    .locator('.svelte-flow__edge[data-id="iam-store"] .svelte-flow__edge-path')
    .evaluate(path => {
      const point = path.getPointAtLength(path.getTotalLength() / 2);
      const screen = new DOMPoint(point.x, point.y).matrixTransform(path.getScreenCTM());
      return { x: screen.x, y: screen.y };
    });
  await page.mouse.click(pathPoint.x, pathPoint.y);
  await page.getByRole('heading', { name: 'Identity writes', exact: true }).waitFor();

  // Inspector and canvas must remain usable without horizontal document overflow.
  for (const width of [1366, 820]) {
    await page.setViewportSize({ width, height: 768 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true
    );
    assert.equal(await page.locator('.graph-canvas').isVisible(), true);
    assert.equal(await page.locator('.inspector').isVisible(), true);
  }
  assert.deepEqual(errors, []);
  console.log(
    'Browser checks passed: rendering, selection, keyboard, stable geometry/viewport, unknown vs zero, responsive layout.'
  );
} finally {
  await browser.close();
}
