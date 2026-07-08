/**
 * record.mjs — drive a Playwright-scriptable web app through a walkthrough's STEPS,
 * recording video and measuring each step's actual on-screen duration so stitch.mjs
 * can pad narration to match.
 *
 * App-agnostic: takes an `adapter` (baseUrl + getStorageState()) and a `steps` array
 * ({id, narration, action(page), tailSlack?}). Nothing here is saga-dash-specific —
 * that lives in adapters/<app>.mjs and walkthroughs/<app>/<feature>/steps.mjs.
 *
 * Sync model: slot[N] = max(actionDuration[N], narrationDuration[N]) + tailSlack[N].
 * The recorder waits exactly that long before moving to step N+1 — it does not need
 * durations.json to run, but uses it (when present) to right-size each wait.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const VIEWPORT = { width: 1440, height: 900 };

const CURSOR_OVERLAY = `
(() => {
  const cursor = document.createElement('div');
  cursor.id = '__walkthrough_cursor__';
  Object.assign(cursor.style, {
    position: 'fixed',
    zIndex: '2147483647',
    width: '26px',
    height: '26px',
    borderRadius: '50%',
    background: 'rgba(220, 38, 38, 0.55)',
    border: '2px solid rgba(220, 38, 38, 0.9)',
    pointerEvents: 'none',
    transition: 'left 220ms ease-out, top 220ms ease-out, transform 120ms ease-out',
    transform: 'translate(-50%, -50%)',
    left: '-100px',
    top: '-100px',
  });
  document.documentElement.appendChild(cursor);
  window.__moveWalkthroughCursor = (x, y) => {
    cursor.style.left = x + 'px';
    cursor.style.top = y + 'px';
  };
  window.__clickWalkthroughCursor = () => {
    cursor.style.transform = 'translate(-50%, -50%) scale(0.7)';
    setTimeout(() => { cursor.style.transform = 'translate(-50%, -50%) scale(1)'; }, 120);
  };
})();
`;

/** Move the cursor overlay to a locator's center with a smooth multi-step glide. */
export async function smoothClick(page, locator) {
  const box = await locator.boundingBox().catch(() => null);
  if (box) {
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.evaluate(([px, py]) => window.__moveWalkthroughCursor?.(px, py), [x, y]);
    await page.mouse.move(x, y, { steps: 18 });
    await page.waitForTimeout(120);
    await page.evaluate(() => window.__clickWalkthroughCursor?.());
  }
  await locator.click();
}

/**
 * Run every step in `steps` against `adapter`, recording video to `outDir/video`.
 * Returns { slots: {[id]: {audio, action, slot}} } — also written to slots.json.
 */
export async function record(steps, adapter, outDir) {
  const durationsPath = path.join(outDir, 'durations.json');
  const durations = existsSync(durationsPath)
    ? JSON.parse(await readFile(durationsPath, 'utf8'))
    : {};

  const videoDir = path.join(outDir, 'video');
  await mkdir(videoDir, { recursive: true });

  const storageState = await adapter.getStorageState();

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: VIEWPORT,
    storageState,
    recordVideo: { dir: videoDir, size: VIEWPORT },
  });
  await context.addInitScript(CURSOR_OVERLAY);

  const page = await context.newPage();
  await page.goto(adapter.baseUrl, { waitUntil: 'domcontentloaded' });

  const slots = {};

  for (const step of steps) {
    const narrationDuration = durations[step.id] ?? 0;
    const tailSlack = (step.tailSlack ?? 0) / 1000;

    const actionStart = Date.now();
    await step.action(page);
    const actionDuration = (Date.now() - actionStart) / 1000;

    const slot = Math.max(actionDuration, narrationDuration) + tailSlack;
    if (actionDuration > narrationDuration + 0.05) {
      console.warn(
        `  ⚠ ${step.id}: action (${actionDuration.toFixed(1)}s) exceeded audio (${narrationDuration.toFixed(1)}s)`,
      );
    }
    console.log(
      `  ${step.id}: audio=${narrationDuration.toFixed(1)}s action=${actionDuration.toFixed(1)}s slot=${slot.toFixed(1)}s`,
    );

    const remaining = slot - actionDuration;
    if (remaining > 0) await page.waitForTimeout(remaining * 1000);

    slots[step.id] = { audio: narrationDuration, action: actionDuration, slot };
  }

  await context.close();
  await browser.close();

  const recordedVideoPath = await page.video()?.path().catch(() => null);
  const finalWebmPath = path.join(videoDir, 'walkthrough.webm');
  if (recordedVideoPath && recordedVideoPath !== finalWebmPath && existsSync(recordedVideoPath)) {
    const { rename } = await import('node:fs/promises');
    await rename(recordedVideoPath, finalWebmPath);
  }

  await writeFile(path.join(outDir, 'slots.json'), JSON.stringify(slots, null, 2));

  return { slots };
}
