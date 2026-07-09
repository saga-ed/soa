/**
 * Walkthrough: creating a new program in saga-dash.
 *
 * Mirrors the real e2e coverage in
 * apps/web/dash/e2e/journey/program-creation.e2e.test.ts (saga-stack-cli flow
 * `saga-dash/journey`, stage `program`) — same route, same form fields, same
 * selectors. Precondition: the `empty@saga.org` persona (an already-rostered org
 * with zero programs, baked into the IAM seed — see
 * apps/web/dash/e2e/data/seed-users.ts), so `/programs` auto-redirects to
 * `/programs/new/config`. Record with:
 *   WALKTHROUGH_LOGIN_EMAIL=empty@saga.org node lib/make.mjs --walkthrough saga-dash/program-creation
 *
 * Narration + timing live in the paired script.md, keyed by step id — see script.mjs.
 */

import { smoothClick } from '../../../lib/record.mjs';

const PROGRAM_NAME = 'Walkthrough Demo Program';

export const STEPS = [
  {
    id: '00-intro',
    action: async (page) => {
      await page.goto('/programs');
      await page.waitForURL('**/programs/new/config', { timeout: 15000 });
      await page.waitForSelector('#pd-name', { timeout: 15000 });
    },
  },
  {
    id: '01-name',
    action: async (page) => {
      await page.locator('#pd-name').fill(PROGRAM_NAME);
    },
  },
  {
    id: '02-timezone',
    action: async (page) => {
      await page.locator('.field-timezone select').selectOption('America/Chicago');
    },
  },
  {
    id: '03-address',
    action: async (page) => {
      await page.locator('#pd-address').fill('123 W Madison St');
      await page.locator('#pd-city').fill('Chicago');
    },
  },
  {
    id: '04-state-zip',
    action: async (page) => {
      await page.locator('.field-state select').selectOption('IL');
      await page.locator('#pd-zip').fill('60601');
    },
  },
  {
    id: '05-save',
    action: async (page) => {
      const saveButton = page.getByRole('button', { name: 'Save', exact: true });
      await smoothClick(page, saveButton);
      await page.waitForURL('**/programs/*/config', { timeout: 15000 });
    },
  },
  {
    id: '06-overview',
    action: async (page) => {
      await page.waitForSelector(`text=${PROGRAM_NAME}`, { timeout: 10000 });
    },
  },
  {
    id: '99-outro',
    action: async (page) => {
      await page.waitForTimeout(500);
    },
  },
];
