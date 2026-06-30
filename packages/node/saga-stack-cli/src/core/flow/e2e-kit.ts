/**
 * The e2e date-kit surface (plan §5.5, saga-ed/soa#214) — layer (2) of the
 * Monday-flake fix.
 *
 * This is the STABLE entry point for the pure date helpers that SPA e2e specs
 * are meant to import, so they can become env-first:
 *
 *   import { occurrenceDate, fmtLocal } from '@saga-ed/saga-stack-e2e-kit';
 *   const OCCURRENCE_DATE =
 *     process.env.PLAYWRIGHT_OCCURRENCE_DATE ?? fmtLocal(occurrenceDate(new Date()));
 *
 * with the CLI (layer 1, `./env.ts::computeEnv`) injecting
 * PLAYWRIGHT_OCCURRENCE_DATE / PLAYWRIGHT_TERM_START / PLAYWRIGHT_TERM_END for
 * every flow. The per-spec `mondayOfCurrentWeek()` copies then delete, so the
 * flake cannot regress in one spec while the others are fixed.
 *
 * NOTE — FOLLOW-UP (cross-repo, NOT this PR): extracting these helpers into a
 * standalone published `@saga-ed/saga-stack-e2e-kit` package, and migrating the
 * saga-dash journey/interactive specs to import from it (deleting their inline
 * date copies), are separate PRs in OTHER repos. For now the kit lives inside
 * `saga-stack-cli` and is re-exported through `core/flow` (and thus `./core`);
 * the future package re-exports from here unchanged.
 *
 * PURE: pure date functions + the env-var name constants only. No `new Date()`
 * in core — callers pass the reference date in.
 */

export {
  ENV_OCCURRENCE_DATE,
  ENV_TERM_START,
  ENV_TERM_END,
  fmtLocal,
  mondayOfWeekOf,
  occurrenceDate,
  todayOrNextWeekday,
} from './env.js';
