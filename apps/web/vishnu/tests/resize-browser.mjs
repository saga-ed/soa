import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const transform = () => page.locator('.svelte-flow__viewport').evaluate(n => n.style.transform);
async function expectFitted() {
  const canvas = await page.locator('.svelte-flow').boundingBox();
  const nodes = await page.locator('.svelte-flow__node').evaluateAll(nodes => nodes.map(n => {
    const r = n.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  }));
  for (const node of nodes) {
    assert.ok(node.left >= canvas.x && node.right <= canvas.x + canvas.width, 'Node fits horizontally');
    assert.ok(node.top >= canvas.y && node.bottom <= canvas.y + canvas.height, 'Node fits vertically');
  }
  const center = (Math.min(...nodes.map(n => n.left)) + Math.max(...nodes.map(n => n.right))) / 2;
  assert.ok(Math.abs(center - (canvas.x + canvas.width / 2)) < 3, 'Mesh centered in resized canvas');
}
try {
  await page.goto(process.env.VISHNU_TEST_URL ?? 'http://127.0.0.1:8930');
  await page.locator('.svelte-flow__edge').first().waitFor();
  await page.getByRole('button', { name: 'Fit mesh', exact: true }).click();
  const initial = await transform();
  await page.setViewportSize({ width: 2560, height: 1440 });
  await page.waitForTimeout(500);
  assert.notEqual(await transform(), initial);
  await expectFitted();
  await page.getByRole('button', { name: 'Hide inspector', exact: true }).click();
  await page.waitForTimeout(500);
  await expectFitted();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(500);
  await expectFitted();
  console.log('Resize checks passed: fullscreen-size growth, inspector toggle, laptop-size shrink, centered visible mesh.');
} finally {
  await browser.close();
}
