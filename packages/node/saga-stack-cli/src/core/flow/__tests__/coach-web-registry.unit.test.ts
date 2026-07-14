/**
 * coach-web registry row (gh_305, M2 — the THIRD-SPA onboarding proof).
 *
 * Onboarding coach-web for `develop coach` is the same M6 pattern proven for
 * connectv3: ONE `spa-registry` row + coach's already-authored `flows.json` —
 * zero new resolver/command/core logic. This pins the row's shape (it must agree
 * with `core/manifest/services.ts` coach-web · COACH · `apps/web/coach-web`) so
 * `discoverFlowManifest('coach-web', …)` resolves the coach checkout, and so a
 * `--hold` hand-off opens coach-web (not the dash) from the right repo.
 */

import { describe, expect, it } from 'vitest';
import { knownSpaIds, lookupSpa } from '../spa-registry.js';

describe('coach-web — first-class registry row (onboarding = 1 row + 1 json)', () => {
  it('is registered and appears in knownSpaIds', () => {
    expect(knownSpaIds()).toContain('coach-web');
    expect(lookupSpa('coach-web')).toBeDefined();
  });

  it('the descriptor matches the coach-web service + coach repo layout', () => {
    // repoEnvVar/defaultRepoSubpath mirror up.sh's COACH path resolution; appDir is
    // the coach-web SvelteKit app (port 8800 lives in the manifest, not the row);
    // e2eDir holds coach's authored flows.json; Playwright runs in appDir.
    expect(lookupSpa('coach-web')).toEqual({
      id: 'coach-web',
      system: 'coach-web',
      repoEnvVar: 'COACH',
      defaultRepoSubpath: 'coach',
      appDir: 'apps/web/coach-web',
      e2eDir: 'apps/web/coach-web/e2e',
      playwrightConfig: 'playwright.config.ts',
    });
  });

  it('leaves the existing saga-dash + connectv3 rows intact', () => {
    // The generalization must not disturb the first two SPAs.
    expect(lookupSpa('saga-dash')?.repoEnvVar).toBe('SAGA_DASH');
    expect(lookupSpa('connectv3')?.repoEnvVar).toBe('QBOARD');
    expect(knownSpaIds()).toEqual(expect.arrayContaining(['saga-dash', 'connectv3', 'coach-web']));
  });
});
