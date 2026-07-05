/**
 * Vendored-script resolution (Phase 1 synthetic-dev DECOUPLING, saga-ed/soa#214).
 *
 * The CLI ships its OWN copies of the self-contained synthetic-dev scripts it shells
 * out to — `tunnel.sh`, `browser-login.mjs`, `refresh-suite.sh` — under the package's
 * `vendor/` dir, so `ss tunnel` / `up --tunnel` / `login --browser` / `overlay
 * compose-rest` no longer reach into a resolved `soa` checkout's `tools/synthetic-dev`.
 * (up.sh/verify.sh are STILL resolved from the soa checkout via `ScriptLocator` —
 * `up --sandbox/--workspace/--record` is Phase 2.)
 *
 * `resolveVendorScript(name)` returns the absolute path to `vendor/<name>` by walking
 * UP from THIS module to the ancestor dir that actually contains `vendor/<name>`. That
 * ancestor is the PACKAGE ROOT in every layout the CLI runs under:
 *   - dev (tsx, from `src/`): this file is `<pkg>/src/runtime/vendor.ts` → `<pkg>/vendor/<name>`.
 *   - local build (tsc, from `dist/`): `<pkg>/dist/runtime/vendor.js` → `<pkg>/vendor/<name>`.
 *   - installed npm: `node_modules/@saga-ed/saga-stack-cli/dist/runtime/vendor.js`
 *     → `node_modules/@saga-ed/saga-stack-cli/vendor/<name>`.
 * Because it resolves from the PACKAGE ROOT (not `dist/`), NO build-time copy of
 * `vendor/` into `dist/` is needed — the dir just has to SHIP, which it does via the
 * package.json `files` allowlist. This is runtime (fs IO), not core.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** How many parent dirs to walk before giving up (src/runtime → pkg is 2; dist/runtime → pkg is 2). */
const MAX_WALK = 12;

/**
 * Absolute path to the vendored script `vendor/<name>` (e.g. `tunnel.sh`,
 * `browser-login.mjs`, `refresh-suite.sh`). Walks up from this module to the first
 * ancestor whose `vendor/<name>` exists — the package root — so it resolves correctly
 * under tsx (src) AND compiled (dist) AND an installed npm layout. Throws with a
 * pointed message if the vendored file is missing (packaging regression).
 */
export function resolveVendorScript(name: string): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < MAX_WALK; i++) {
    const candidate = join(dir, 'vendor', name);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break; // hit the filesystem root
    dir = parent;
  }
  throw new Error(
    `saga-stack: could not resolve vendored script 'vendor/${name}' from ${fileURLToPath(import.meta.url)}\n` +
      "  the CLI ships this script under the package's vendor/ dir — a missing file means a packaging regression " +
      '(is "vendor" in package.json "files"?).',
  );
}
