/**
 * `resolveVendorScript` unit tests (Phase 1 synthetic-dev DECOUPLING, saga-ed/soa#214).
 *
 * The CLI ships its OWN copies of the self-contained synthetic-dev scripts under the
 * package's `vendor/` dir. `resolveVendorScript(name)` must return the absolute path to
 * an EXISTING `vendor/<name>` under the package root — resolved from `import.meta.url`
 * (walking up), so it works under tsx (src) here and compiled (dist) in production with
 * NO build-time copy into `dist/`. These assert the three vendored files resolve to real
 * on-disk paths under the package, and that a missing name throws a pointed error.
 */

import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveVendorScript } from '../vendor.js';

const PKG_ROOT = process.cwd();
const VENDOR_DIR = resolve(PKG_ROOT, 'vendor');

describe('resolveVendorScript', () => {
  it.each(['tunnel.sh', 'browser-login.mjs', 'refresh-suite.sh'])(
    'resolves %s to an existing file under the package vendor dir',
    (name) => {
      const p = resolveVendorScript(name);
      expect(p).toBe(resolve(VENDOR_DIR, name));
      expect(existsSync(p)).toBe(true);
      expect(statSync(p).isFile()).toBe(true);
      // decoupled: NOT a tools/synthetic-dev path.
      expect(p).not.toContain('tools/synthetic-dev');
    },
  );

  it('throws a pointed packaging-regression error for a missing vendored script', () => {
    expect(() => resolveVendorScript('does-not-exist.sh')).toThrow(/could not resolve vendored script/);
  });
});
