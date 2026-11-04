import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(15000);
const base = process.env.VISHNU_TEST_URL ?? 'http://127.0.0.1:11930';
const errors = [];
page.on('pageerror', error => errors.push(error.message));
let navigations = 0;
page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });
const button = name => page.getByRole('button', { name, exact: true });
const viewport = () => page.locator('.svelte-flow__viewport').evaluate(el => el.style.transform);
async function settle() {
  await page.waitForFunction(() => document.querySelector('.graph-label-layer')?.dataset.layoutMoving === 'false');
  // Camera and layout animations have independent clocks; require a stable camera too.
  let previous = await viewport();
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(100);
    const current = await viewport();
    if (current === previous && i >= 6) return;
    previous = current;
  }
  assert.fail('Camera never settled');
}
async function context(count) {
  await page.waitForFunction(n => document.querySelectorAll('.context-node').length === n, count);
  await settle();
}
async function allVisible() {
  await settle();
  const outside = await page.evaluate(() => {
    const canvas = document.querySelector('.graph-canvas').getBoundingClientRect();
    return [...document.querySelectorAll('.svelte-flow__node')].filter(node => {
      const r = node.getBoundingClientRect();
      return !Number.isFinite(r.x) || r.width <= 0 || r.left < canvas.left - 2 || r.right > canvas.right + 2 || r.top < canvas.top - 2 || r.bottom > canvas.bottom + 2;
    }).map(node => node.dataset.id);
  });
  assert.deepEqual(outside, [], 'Fit/reset must put every node inside the canvas');
}
async function reset() {
  await button('Reset view').click();
  await context(0);
  assert.equal(await page.getByLabel('Signal view').inputValue(), 'overview');
  assert.equal(await page.getByLabel('Find a system').inputValue(), '');
  assert.equal(await page.getByLabel('Reflow signal focus').isChecked(), true);
  assert.equal(await page.locator('.inspector').count(), 0);
  assert.equal(await page.locator('#mesh-list').count(), 0);
  assert.equal(await page.locator('.svelte-flow__node.selected,.svelte-flow__edge.selected').count(), 0);
  assert.equal(await button('Focus canvas').getAttribute('aria-pressed'), 'false');
  await allVisible();
}
try {
  await page.goto(`${base}/?mode=demo`);
  await page.locator('.path-label').first().waitFor();
  await settle();
  const initialNavigations = navigations;
  const edgeCount = await page.locator('.svelte-flow__edge').count();
  await page.getByLabel('Signal view').selectOption('hot');
  await context(7);
  await button('Fit mesh').click();
  await context(0);
  await allVisible();
  await page.getByLabel('Signal view').selectOption('slow');
  await context(5);
  await page.getByLabel('Signal view').selectOption('hot');
  await context(7);
  await reset();

  const before = await viewport();
  await page.getByLabel('Find a system').fill('Scheduling');
  await page.locator('.search-results').getByRole('button', { name: 'Scheduling API', exact: true }).click();
  await page.getByRole('heading', { name: 'Scheduling API', exact: true }).waitFor();
  await settle();
  assert.equal(await viewport(), before, 'Opening inspector must preserve the camera');
  await button('Browse as list').click();
  await button('Hide list').click();
  await button('Hide inspector').click();
  await settle();
  assert.equal(await viewport(), before, 'Closing inspector/list must preserve the camera');

  await page.getByLabel('Reflow signal focus').uncheck();
  await button('Focus selection').click();
  await context(8);
  await page.keyboard.press('Escape');
  await context(0);
  await reset();
  for (const filter of ['hot', 'slow', 'error', 'attention', 'fanout', 'overview']) {
    await page.getByLabel('Signal view').selectOption(filter);
  }
  await context(0);
  assert.equal(await page.locator('.svelte-flow__edge').count(), edgeCount);

  for (const width of [1440, 1366, 820]) {
    await page.setViewportSize({ width, height: 900 });
    await settle();
    await page.getByLabel('Signal view').selectOption('hot');
    await context(7);
    await page.getByLabel('Find a system').fill('IAM');
    await page.locator('.search-results').getByRole('button', { name: 'IAM API', exact: true }).click();
    await button('Fit selection').click();
    await button('Focus canvas').click();
    await button('Browse as list').click();
    await reset();
    await reset();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No horizontal page overflow');
    await page.screenshot({ path: `/tmp/vishnu-ux-recovery-${width}.png`, fullPage: true });
  }
  assert.equal(navigations, initialNavigations, 'Recovery must never reload the page');
  // Run the same recovery against the actual local collector and current data.
  const mesh = await (await fetch(new URL('/api/mesh', base))).json();
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(base);
  await page.waitForFunction(count => document.querySelectorAll('.svelte-flow__node').length === count, mesh.systems.length);
  await reset();
  for (const system of mesh.systems) {
    const node = page.locator(`.svelte-flow__node[data-id="${system.id}"]`);
    assert.equal(await node.count(), 1, `${system.id} must be represented`);
    if (system.runtimeState) assert.ok((await node.innerText()).toLowerCase().includes(system.runtimeState.replaceAll('-', ' ')), `${system.id} runtime state is visible`);
  }
  const liveNavigations = navigations;
  await page.getByLabel('Find a system').fill('ads-adm-api');
  await page.locator('.search-results').getByRole('button', { name: 'ads-adm-api', exact: true }).click();
  await page.getByRole('heading', { name: 'ads-adm-api', exact: true }).waitFor();
  await page.getByLabel('Signal view').selectOption('hot');
  await settle();
  await page.getByLabel('Signal view').selectOption('slow');
  await settle();
  await reset();
  assert.equal(navigations, liveNavigations);
  await page.screenshot({ path: '/tmp/vishnu-ux-live-inventory.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log(`PASS: Fit mesh, filter revisits, inspector camera stability, explicit focus, Escape and repeated Reset view at desktop/laptop/narrow widths without reload; live inventory ${mesh.systems.length} systems`);
} catch (error) {
  await page.screenshot({ path: '/tmp/vishnu-ux-recovery-failure.png', fullPage: true });
  console.error(await page.locator('body').innerText());
  throw error;
} finally { await browser.close(); }
