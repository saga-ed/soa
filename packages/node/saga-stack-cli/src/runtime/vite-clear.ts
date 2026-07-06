/**
 * vite-clear — the fs seam that clears the stale-vite-bundle caches on a native
 * `restart` (M9; a faithful port of up.sh's `nuke_vite`, ~2012-2019).
 *
 * A dead Vite watcher serving old optimized JS even though the source changed (e.g.
 * after a branch swap) is the "restart didn't pick up my change" trap. up.sh's
 * `restart`/`--reset` clears these caches between the service stop and the fresh
 * bring-up; the native `restart` does the same through this injectable seam.
 *
 * The path DERIVATION (`viteCachePaths`) is PURE (path building only) so the exact
 * path list is unit-asserted with no fs; the IO (`makeRealViteClear`) is the ONLY
 * place a real `rm -rf` runs. Paths mirror `nuke_vite` EXACTLY (else the stale-bundle
 * trap returns):
 *   1. `$SAGA_DASH/apps/web/dash/node_modules/.vite`      (explicit rm -rf)
 *   2. `find $SAGA_DASH/apps $SAGA_DASH/packages -type d -name .vite … -exec rm -rf`
 *      (recursive scan of the dash app + package caches)
 *   3. `$QBOARD/apps/web/connectv3/node_modules/.vite`    (explicit rm -rf — connect-web is vite too)
 *
 * NOTE (divergence, deliberate): up.sh's `restart`/`--reset` ALSO reaps host-global
 * `pkill -f tsup`/`fuser -k <port>` in `services_down`. The native restart uses the
 * dir-scoped launcher teardown (kill-by-pidfile) instead — strictly safer, slot-safe
 * — and SKIPS the host-global reap. See `stack-api.ts` `restart`.
 *
 * INVARIANT: fs IO lives only in `src/runtime/**`; `src/core/**` never imports this.
 */

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** The vite cache locations to clear, split by removal strategy. */
export interface ViteCachePaths {
  /** Absolute `.vite` dirs to `rm -rf` directly (the two `node_modules/.vite` fast paths). */
  explicit: string[];
  /** Roots to recursively scan for any dir named `.vite` and remove (up.sh's `find … -name .vite`). */
  scanRoots: string[];
}

/**
 * Derive the vite cache path list from the resolved SAGA_DASH + QBOARD roots — the
 * byte-faithful equivalent of `nuke_vite`. PURE (no fs).
 */
export function viteCachePaths({
  sagaDashRoot,
  qboardRoot,
}: {
  sagaDashRoot: string;
  qboardRoot: string;
}): ViteCachePaths {
  const dash = sagaDashRoot.replace(/\/+$/, '');
  const qboard = qboardRoot.replace(/\/+$/, '');
  return {
    explicit: [
      join(dash, 'apps/web/dash/node_modules/.vite'),
      join(qboard, 'apps/web/connectv3/node_modules/.vite'),
    ],
    scanRoots: [join(dash, 'apps'), join(dash, 'packages')],
  };
}

/** The outcome of a vite-clear pass. */
export interface ViteClearResult {
  /** Absolute `.vite` dirs that were found and removed (explicit + scanned). */
  removed: string[];
}

/** The injectable vite-clear seam. `clear` removes every derived cache dir (best-effort). */
export interface ViteClear {
  clear(paths: ViteCachePaths): Promise<ViteClearResult>;
}

/** Injectable low-level fs deps of the real vite-clear (defaulted to real IO). */
export interface RealViteClearDeps {
  /** Does a path exist? Default `fs.existsSync`. */
  exists?: (p: string) => boolean;
  /** Is a path a directory? Default `fs.statSync(p).isDirectory()` (folds an error to false). */
  isDir?: (p: string) => boolean;
  /** List a dir's entries. Default `fs.readdirSync`; `[]` on any error. */
  listDir?: (p: string) => string[];
  /** `rm -rf` a path. Default `fs.rmSync(p,{recursive,force})` (best-effort — swallows errors). */
  remove?: (p: string) => void;
}

/**
 * The production vite-clear: `rm -rf` each explicit `.vite` dir, then recursively
 * walk each scan root for dirs named `.vite` (NOT descending INTO a matched `.vite`,
 * mirroring `find … -prune`) and remove them. Every op is best-effort (a missing dir
 * / permission error is a no-op), matching up.sh's `2>/dev/null || true`.
 */
export function makeRealViteClear(deps: RealViteClearDeps = {}): ViteClear {
  const exists = deps.exists ?? ((p: string) => existsSync(p));
  const isDir =
    deps.isDir ??
    ((p: string): boolean => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    });
  const listDir =
    deps.listDir ??
    ((p: string): string[] => {
      try {
        return readdirSync(p);
      } catch {
        return [];
      }
    });
  const remove =
    deps.remove ??
    ((p: string): void => {
      try {
        rmSync(p, { recursive: true, force: true });
      } catch {
        // best-effort — a cache we can't remove is cosmetic; never abort the restart.
      }
    });

  /** Depth-first collect `.vite` dirs under `root`, NOT descending into a match (`-prune`). */
  function scan(root: string, out: string[]): void {
    if (!isDir(root)) return;
    for (const entry of listDir(root)) {
      const child = join(root, entry);
      if (!isDir(child)) continue;
      if (entry === '.vite') {
        out.push(child); // matched — prune (don't recurse into it)
      } else {
        scan(child, out);
      }
    }
  }

  return {
    async clear(paths: ViteCachePaths): Promise<ViteClearResult> {
      const targets: string[] = [];
      for (const p of paths.explicit) {
        if (exists(p)) targets.push(p);
      }
      for (const root of paths.scanRoots) scan(root, targets);

      // De-dup (an explicit path can also be found by the scan) preserving order.
      const removed: string[] = [];
      const seen = new Set<string>();
      for (const p of targets) {
        if (seen.has(p)) continue;
        seen.add(p);
        remove(p);
        removed.push(p);
      }
      return { removed };
    },
  };
}
