/**
 * Cross-language parity: `scripts/clone-repos.sh`'s repo lists vs this module's.
 *
 * `clone-repos.sh` bootstraps a bare machine — it runs via `gh api … | bash` with no
 * checkout and no node, so it CANNOT import `REQUIRED_BOOTSTRAP_REPOS` and hardcodes the
 * list instead. That literal is the drift risk: `REQUIRED_BOOTSTRAP_REPOS` is DERIVED
 * (`Object.keys(REPO_DEFAULT_DIR)` minus the excluded), so adding a sibling repo to the
 * manifest grows the TS set automatically while the bash array silently goes stale —
 * under-provisioning every new machine with nothing to catch it.
 *
 * The script's "keep the two in sync" comment is the ask; this test is the enforcement.
 * It parses the arrays out of the shell source as text (the only way to read them without
 * executing a script that shells out to `gh`) and pins them to the derived TS values.
 *
 * Follows the `core/manifest/__tests__/consistency.unit.test.ts` idiom: pin
 * hand-maintained parallel structures against the canonical source.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REPO_DEFAULT_DIR } from '../scripts.js';
import { GITHUB_ORG, bootstrapRepos } from '../ensure-repos.js';

/** `src/runtime/__tests__` → package root → `scripts/clone-repos.sh`. */
const SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../../scripts/clone-repos.sh');
const SCRIPT = readFileSync(SCRIPT_PATH, 'utf8');

/**
 * Extract a bash array literal — `NAME=(a b c)` — as its element list. Deliberately
 * strict: a multi-line or interpolated array fails to match and the test errors loudly
 * rather than silently comparing against `[]`.
 */
function bashArray(name: string): string[] {
    const match = SCRIPT.match(new RegExp(`^${name}=\\(([^)]*)\\)`, 'm'));
    if (!match) throw new Error(`could not parse ${name}=(...) out of ${SCRIPT_PATH}`);
    return match[1].trim().split(/\s+/).filter(Boolean);
}

describe('clone-repos.sh ↔ ensure-repos.ts parity', () => {
    it('REQUIRED matches the derived REQUIRED_BOOTSTRAP_REPOS, in order', () => {
        expect(bashArray('REQUIRED')).toEqual(bootstrapRepos().map((r) => r.name));
    });

    it('OPTIONAL is exactly the repos bootstrap excludes (coach + fleek)', () => {
        const required = new Set(bootstrapRepos().map((r) => r.name));
        const excluded = Object.values(REPO_DEFAULT_DIR).filter((dir) => !required.has(dir));
        expect(bashArray('OPTIONAL')).toEqual(excluded);
    });

    it('every repo in the manifest is either REQUIRED or OPTIONAL — none dropped', () => {
        const covered = [...bashArray('REQUIRED'), ...bashArray('OPTIONAL')].sort();
        expect(covered).toEqual(Object.values(REPO_DEFAULT_DIR).sort());
    });

    it('clones from the same GitHub org', () => {
        expect(SCRIPT).toMatch(new RegExp(`^ORG=${GITHUB_ORG}$`, 'm'));
    });
});
