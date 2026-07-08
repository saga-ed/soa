/**
 * Narrated walkthrough: creating a new program in saga-dash.
 *
 * Mirrors the real e2e coverage in
 * apps/web/dash/e2e/journey/program-creation.e2e.test.ts (saga-stack-cli flow
 * `saga-dash/journey`, stage `program`) — same route, same form fields, same
 * selectors. Precondition: the `empty@saga.org` persona (an already-rostered org
 * with zero programs, baked into the IAM seed — see
 * apps/web/dash/e2e/data/seed-users.ts), so `/programs` auto-redirects to
 * `/programs/new/config`. Record with:
 *   WALKTHROUGH_LOGIN_EMAIL=empty@saga.org node lib/make.mjs --walkthrough saga-dash/program-creation
 */

import { smoothClick } from '../../../lib/record.mjs';

const PROGRAM_NAME = 'Walkthrough Demo Program';

export const STEPS = [
  {
    id: '00-intro',
    narration:
      "Welcome to the program creation walkthrough in Saga Dash. We'll start from " +
      'the Programs page and create a brand new program from scratch.',
    action: async (page) => {
      await page.goto('/programs');
      await page.waitForURL('**/programs/new/config', { timeout: 15000 });
      await page.waitForSelector('#pd-name', { timeout: 15000 });
    },
    tailSlack: 800,
  },
  {
    id: '01-name',
    narration:
      "Since this district has no programs yet, we're dropped straight into the new " +
      `program form. First, we give it a name: "${PROGRAM_NAME}".`,
    action: async (page) => {
      await page.locator('#pd-name').fill(PROGRAM_NAME);
    },
    tailSlack: 500,
  },
  {
    id: '02-timezone',
    narration: 'Next, the program time zone — we pick Central Time, America Chicago.',
    action: async (page) => {
      await page.locator('.field-timezone select').selectOption('America/Chicago');
    },
    tailSlack: 500,
  },
  {
    id: '03-address',
    narration:
      'Address details are optional, but filling them in helps identify the program later. ' +
      'We enter one two three West Madison Street, Chicago.',
    action: async (page) => {
      await page.locator('#pd-address').fill('123 W Madison St');
      await page.locator('#pd-city').fill('Chicago');
    },
    tailSlack: 500,
  },
  {
    id: '04-state-zip',
    narration: 'Then the state — Illinois — and the ZIP code, six oh six oh one.',
    action: async (page) => {
      await page.locator('.field-state select').selectOption('IL');
      await page.locator('#pd-zip').fill('60601');
    },
    tailSlack: 500,
  },
  {
    id: '05-save',
    narration:
      "With everything filled in, we click Save. Saga Dash creates the program and takes " +
      'us straight to its overview page.',
    action: async (page) => {
      const saveButton = page.getByRole('button', { name: 'Save', exact: true });
      await smoothClick(page, saveButton);
      await page.waitForURL('**/programs/*/config', { timeout: 15000 });
    },
    tailSlack: 1000,
  },
  {
    id: '06-overview',
    narration:
      'And there it is — the new program overview, showing the name we chose. Saga Dash ' +
      'also flags that the program still needs people enrolled before it can go live.',
    action: async (page) => {
      await page.waitForSelector(`text=${PROGRAM_NAME}`, { timeout: 10000 });
    },
    tailSlack: 1200,
  },
  {
    id: '99-outro',
    narration:
      "That's the full program creation flow — name, time zone, address, and save. " +
      'Thanks for watching.',
    action: async (page) => {
      await page.waitForTimeout(500);
    },
    tailSlack: 1500,
  },
];
