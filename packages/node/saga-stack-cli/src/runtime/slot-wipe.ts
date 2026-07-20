/**
 * `slot-wipe` — the per-slot state-dir / snapshots-root removal a `stack wipe` needs (soa#340).
 *
 * `stack wipe --slot N` pristine-resets ONE slot: stop its native services, `docker compose
 * -p soa-s<N> down -v`, then `rm -rf` the slot's state dir (`/tmp/sds-synthetic-s<N>` —
 * pids/logs/cookies AND `claim.json`, so the slot vanishes from `stack slots`) and, only
 * under `--snapshots`, the slot's snapshot root (`~/.saga-mesh/snapshots-s<N>`). The first
 * two steps reuse existing seams (`ServiceStopper`, `DockerWipe.composeDownVolumes`); this
 * module supplies the third: there is NO shared recursive-remove seam in runtime/ (BuildCleaner
 * is repo-dist-scoped, `deleteSnapshot` is per-fixture), so — following the house convention
 * (build-clean.ts / vite-clear.ts) — the `rm -rf` lives behind a small injectable seam whose
 * `makeSlotWipe()` factory is the ONLY real `rmSync` site here. Best-effort: a
 * missing dir is a clean no-op (`false`), an rm failure folds to `false`, never a throw.
 *
 * Also home to `relativeAge` — the pure ISO-timestamp → "3m"/"2h"/"4d" formatter the wipe
 * live-claim guard renders ("claimed by <actor> <age> ago and still running"). No such helper
 * existed anywhere in the package (`stack slots` prints the raw ISO `claim.at`), hence new code.
 *
 * INVARIANT (plan hard constraint): destructive IO lives only in `src/runtime/**`.
 */

import { existsSync, rmSync } from 'node:fs';

/**
 * PURE: render the age of an ISO-8601 timestamp as a compact single unit —
 * `42s`, `3m`, `2h`, then `4d` from 48 hours up. Clock skew (a future `at`)
 * clamps to `0s`; an unparseable timestamp folds to `an unknown time` so the
 * guard message stays readable ("claimed … an unknown time ago").
 */
export function relativeAge(atIso: string, nowMs: number = Date.now()): string {
  const at = Date.parse(atIso);
  if (Number.isNaN(at)) return 'an unknown time';
  const s = Math.max(0, Math.floor((nowMs - at) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/**
 * The injectable slot-dir removal seam (`stack wipe` steps c/d). Two verbs:
 * `rm -rf` a single absolute dir, and the existence probe `--slot all` uses to
 * decide which slots are non-empty candidates (soa#351). Production wires
 * `makeSlotWipe()` (the only place this module's real `rmSync` runs); tests pass
 * a recording fake so the removal PLAN (which paths, in what order) is asserted
 * with no fs.
 */
export interface SlotWipe {
  /** Does the dir exist? (candidate detection for `--slot all`; folds errors to `false`). */
  exists(dir: string): boolean;
  /** `rm -rf dir`; `true` iff the dir existed and was removed, `false` otherwise (best-effort — never throws). */
  remove(dir: string): boolean;
}

/** Injectable low-level fs deps of the real remover (defaulted to real IO). */
export interface RealSlotWipeDeps {
  /** Does the path exist? Default `fs.existsSync` (folds an error to false). */
  exists?: (p: string) => boolean;
  /** `rm -rf` a path. Default `fs.rmSync(p, { recursive, force })`. */
  remove?: (p: string) => void;
}

/**
 * The production slot-dir remover. Best-effort by design (matching BuildCleaner):
 * an absent dir answers `false` without touching the fs, and an rm failure
 * (permissions, a vanished mount) also folds to `false` — the command reports
 * "not removed", it never aborts the wipe chain.
 */
export function makeSlotWipe(deps: RealSlotWipeDeps = {}): SlotWipe {
  const exists =
    deps.exists ??
    ((p: string): boolean => {
      try {
        return existsSync(p);
      } catch {
        return false;
      }
    });
  const remove =
    deps.remove ??
    ((p: string): void => {
      rmSync(p, { recursive: true, force: true });
    });

  return {
    exists(dir: string): boolean {
      return exists(dir);
    },
    remove(dir: string): boolean {
      if (!exists(dir)) return false;
      try {
        remove(dir);
        return true;
      } catch {
        return false;
      }
    },
  };
}
