/**
 * Vendored `tunnel.sh` drift guard (Tunnel Mode, saga-ed/soa#298; re-vendor debt from #224).
 *
 * The CLI ships its OWN copy of `tunnel.sh` under the package's `vendor/` dir (see
 * `vendor.ts`), so `ss tunnel` / `up --tunnel` no longer reach into a resolved soa
 * checkout's `tools/synthetic-dev`. But a vendored copy silently ROTS when the source
 * changes and the copy is not refreshed — exactly what happened in #224 (coach:8800 /
 * coach-api:6105 + the `|| coach` status-probe branch landed in the source but the
 * vendored copy was never re-vendored). This asserts the two files are byte-identical.
 *
 * SCOPED TO tunnel.sh ONLY — the other files under `vendor/` (`refresh-suite.sh`,
 * `.gitignore`) are INTENTIONALLY forked from the source tree and must NOT be asserted.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** Walk UP from `start` to the first ancestor for which `join(dir, ...rel)` exists. */
function findUp(start: string, rel: string[]): string {
    let dir = start;
    for (let i = 0; i < 12; i++) {
        const candidate = join(dir, ...rel);
        if (existsSync(candidate)) return candidate;
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    throw new Error(`vendor-tunnel-drift: could not locate ${rel.join('/')} walking up from ${start}`);
}

describe('vendored tunnel.sh drift guard', () => {
    it('is byte-identical to tools/synthetic-dev/tunnel.sh', () => {
        const here = dirname(fileURLToPath(import.meta.url));
        // Resolve both relative to the package (walk up), so cwd is irrelevant.
        const vendorPath = findUp(here, ['vendor', 'tunnel.sh']);
        const sourcePath = findUp(here, ['tools', 'synthetic-dev', 'tunnel.sh']);

        const source = readFileSync(sourcePath);
        const vendored = readFileSync(vendorPath);

        expect(vendored.equals(source)).toBe(true);
    });
});
