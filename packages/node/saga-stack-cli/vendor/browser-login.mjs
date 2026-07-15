#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// browser-login.mjs — open a real Chromium already logged into the dash.
//
// Why this exists: up.sh's `--login` curl mints a session into a cookie JAR,
// which is useless to your browser — HttpOnly cookies can't be transplanted
// into a running browser, so the dash bounces to the Janus redirect. This does
// the devLogin INSIDE a browser context (persistent profile), so the iam_session
// cookie lands where the dash can use it, then opens the dash in that window.
//
// It replicates the exact manual flow (devLogin at the iam-api origin, then the
// dash at :8900 reuses the localhost cookie) — just automated.
//
// Invoked by up.sh (auto-login-browser mode). Playwright is resolved from
// saga-dash's node_modules via createRequire, so nothing needs installing here.
//
// Env in:
//   IAM_URL          iam-api base       (default http://localhost:3010)
//   DASH_URL         dash base          (default http://localhost:8900)
//   DASH_URLS        comma-separated dash bases → one TAB each (overrides DASH_URL)
//   LOGIN_EMAIL      persona to log in  (default dev@saga.org)
//   PROFILE_DIR      persistent profile (default /tmp/sds-synthetic/browser-profile)
//   SAGA_DASH_DASH   path to saga-dash apps/web/dash (for playwright resolution)
//   HEADLESS=1       run headless (verification only; default headful)
//
// Prints one sentinel line for up.sh to grep:
//   AUTOLOGIN_OK <email> <userId> <finalUrl>
//   AUTOLOGIN_FAIL <reason>
// ─────────────────────────────────────────────────────────────────────────────
import { createRequire } from 'node:module';
import path from 'node:path';

const IAM_URL  = process.env.IAM_URL     || 'http://localhost:3010';
const DASH_URL = process.env.DASH_URL    || 'http://localhost:8900';
const EMAIL    = process.env.LOGIN_EMAIL || 'dev@saga.org';
const PROFILE  = process.env.PROFILE_DIR || '/tmp/sds-synthetic/browser-profile';
const DASH_DIR = process.env.SAGA_DASH_DASH;
const HEADLESS = process.env.HEADLESS === '1';

const fail = (reason) => { console.log(`AUTOLOGIN_FAIL ${reason}`); process.exit(1); };

if (!DASH_DIR) fail('SAGA_DASH_DASH not set');

let chromium;
try {
  const require = createRequire(path.join(DASH_DIR, 'package.json'));
  ({ chromium } = require('playwright'));
} catch (e) {
  fail(`cannot load playwright from ${DASH_DIR}: ${e.message}`);
}

let ctx;
try {
  ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: HEADLESS,
    viewport: null,
    args: ['--start-maximized'],
  });
} catch (e) {
  fail(`could not launch Chromium (profile in use? missing DISPLAY?): ${e.message}`);
}

// devLogin via the context's request API — it shares cookie storage with the
// browser context, so Set-Cookie lands in the persistent profile. The Origin
// header satisfies iam-api's pre-session origin allowlist (same check the
// /demo page passes).
const res = await ctx.request.post(`${IAM_URL}/trpc/auth.devLogin`, {
  headers: { 'Content-Type': 'application/json', Origin: IAM_URL },
  // rostering#756: devLogin takes `identifier` (uuid | email); the old `email`-only
  // body now 400s (identifier undefined). Send both keys — same shape as the
  // native jar path (core/login.ts buildDevLoginRequest).
  data: { identifier: EMAIL, email: EMAIL },
});
if (!res.ok()) {
  const body = await res.text().catch(() => '');
  await ctx.close();
  fail(`devLogin HTTP ${res.status()} for ${EMAIL} ${body}`.trim());
}

const cookies = await ctx.cookies(IAM_URL);
if (!cookies.some((c) => c.name === 'iam_session')) {
  await ctx.close();
  fail('devLogin returned 200 but no iam_session cookie was set');
}

// Prove the session actually authenticates before we hand over the window.
const who = await ctx.request.get(`${IAM_URL}/trpc/auth.whoami`);
let userId = 'unknown';
try {
  userId = (await who.json())?.result?.data?.userId ?? 'unknown';
} catch { /* leave unknown */ }
if (!who.ok() || userId === 'unknown') {
  await ctx.close();
  fail(`whoami did not confirm a session (HTTP ${who.status()})`);
}

// DASH_URLS (comma-separated) opens one TAB per url in this ONE logged-in profile
// (frontend-compare mode); an unset DASH_URLS keeps the original single-tab flow.
const urls = (process.env.DASH_URLS || DASH_URL)
  .split(',')
  .map((u) => u.trim())
  .filter(Boolean);
if (urls.length === 0) fail('DASH_URLS resolved to no usable urls');
let firstPage;
for (let i = 0; i < urls.length; i++) {
  const page = i === 0 ? (ctx.pages()[0] ?? (await ctx.newPage())) : await ctx.newPage();
  if (i === 0) firstPage = page;
  await page.goto(urls[i], { waitUntil: 'domcontentloaded' }).catch(() => {});
}
// Give the dash's tRPC auth probe a moment, then report where we ended up so a
// lingering Janus redirect is visible in the log.
await firstPage.waitForTimeout(1500);
const finalUrl = firstPage.url();

console.log(`AUTOLOGIN_OK ${EMAIL} ${userId} ${finalUrl}`);

if (HEADLESS) {
  await ctx.close();
  process.exit(0);
}

// Headful: keep the process (and the window) alive until the user closes it.
ctx.on('close', () => process.exit(0));
await new Promise(() => {});
