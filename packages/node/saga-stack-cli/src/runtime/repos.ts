/**
 * Sibling-repo discovery → the path env vars up.sh reads.
 *
 * up.sh's header (~lines 167-185) lets every sibling repo path be overridden
 * via an env var, each defaulting to `$DEV/<repo>`:
 *
 *     DEV=${DEV:-$HOME/dev}
 *     SOA=${SOA:-$DEV/soa}
 *     ROSTERING=${ROSTERING:-$DEV/rostering}
 *     PROGRAM_HUB=${PROGRAM_HUB:-$DEV/program-hub}
 *     SAGA_DASH=${SAGA_DASH:-$DEV/saga-dash}
 *     SDS=${SDS:-$DEV/student-data-system}
 *     QBOARD=${QBOARD:-$DEV/qboard}
 *     RTSM=${RTSM:-$DEV/rtsm}
 *     FLEEK=${FLEEK:-$DEV/fleek}
 *
 * The M1 wrappers do NOT recompute those defaults — they let up.sh's own
 * `${VAR:-$DEV/<repo>}` defaulting stand. This module therefore emits an env
 * var ONLY for a repo the user actually pinned (a non-empty override), plus
 * `DEV` itself when `--dev` is given. Everything left unset falls through to
 * up.sh's default. The returned map is layered on top of the parent env by the
 * real Runner.
 *
 * Pure data: no spawning, no fs. The CLI flag keys here are the `repoFlags`
 * keys from `shared-flags.ts` (kebab-case); the env var names are up.sh's.
 */

/** CLI-flag keys for the per-repo overrides — matches `repoFlags` in shared-flags.ts. */
export type RepoKey =
  | 'soa'
  | 'rostering'
  | 'program-hub'
  | 'saga-dash'
  | 'coach'
  | 'sds'
  | 'qboard'
  | 'rtsm'
  | 'fleek';

/**
 * Map each `--<repo>` flag to the EXACT env var up.sh reads for that repo's
 * path. (Note `sds` → `SDS`, whose default checkout dir is
 * `student-data-system`, resolved by up.sh — not here.)
 */
export const REPO_ENV_VAR: Record<RepoKey, string> = {
  soa: 'SOA',
  rostering: 'ROSTERING',
  'program-hub': 'PROGRAM_HUB',
  'saga-dash': 'SAGA_DASH',
  coach: 'COACH',
  sds: 'SDS',
  qboard: 'QBOARD',
  rtsm: 'RTSM',
  fleek: 'FLEEK',
};

/**
 * User-supplied workspace overrides: the `--dev` root plus any per-repo path
 * pins. Every field is optional; an absent/empty value means "let up.sh
 * default it".
 */
export type RepoOverrides = { dev?: string } & Partial<Record<RepoKey, string>>;

/**
 * Build the subset of env vars up.sh should see, given the user's overrides.
 *
 * - `DEV` is set only when `--dev` was provided (truthy). Note up.sh runs
 *   `set -u`, so to be safe an absent `--dev` is simply omitted and up.sh's own
 *   `DEV=${DEV:-$HOME/dev}` supplies it.
 * - Each `<repo>` env var is set ONLY when its override is a non-empty string.
 *
 * The result is a flat `Record<string,string>` ready to drop into a
 * `ScriptInvocation.env`.
 */
export function buildRepoEnv(overrides: RepoOverrides = {}): Record<string, string> {
  const env: Record<string, string> = {};

  if (overrides.dev) env.DEV = overrides.dev;

  for (const repo of Object.keys(REPO_ENV_VAR) as RepoKey[]) {
    const value = overrides[repo];
    if (value) env[REPO_ENV_VAR[repo]] = value;
  }

  return env;
}
