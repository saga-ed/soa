/**
 * Shared set-command fakes (M15-C test-harness consolidation).
 *
 * One home for the seam spies the `set …` integration suites (set-commands /
 * set-flag / set-preflight) previously each declared inline: the canned set
 * store, the canned git runner, the pinned fresh-check, the canned slot
 * activity probe, and the zero-IO probe command. Everything is spied on
 * `BaseCommand.prototype` — mirroring how `getRunner`/`getGitRunner`/… are
 * mocked everywhere else — so the spies apply to every command class and are
 * torn down by the suites' own `vi.restoreAllMocks()`.
 *
 * Deliberately parameterized, never defaulted, where the suites diverge:
 * `spyPrepFresh` REQUIRES the prebuilt verdict, `spySlotActive` REQUIRES the
 * active-project list, and `makeProbeCommand` REQUIRES each call site to name
 * whether the probe runs the M13-B preflight. Store FIXTURES stay in the
 * tests — the scenario deltas (slot bindings, createdFrom drift, which repo a
 * set pins) are the point of each test — except the two shapes repeated
 * verbatim across suites (`oneSetWithSagaDash`, `twoSetsSharingCheckout`).
 */

import { Flags } from '@oclif/core';
import type { Config } from '@oclif/core';
import { vi } from 'vitest';
import { BaseCommand } from '../../base-command.js';
import { parseWorktreeSetsFile } from '../../core/set/index.js';
import type { GitRunner, SetStore, SlotActiveProbe } from '../../runtime/index.js';

/** Canned path every faked store reports; asserted verbatim by `set list`. */
export const CANNED_STORE_PATH = '/canned/worktree-sets.json';

/**
 * Spy `getSetStore` to a canned store: `load()` runs the REAL
 * `parseWorktreeSetsFile` over `data`, so schema violations still throw
 * exactly as they would off disk.
 */
export function spySetStore(data: unknown): void {
  const store: SetStore = {
    path: () => CANNED_STORE_PATH,
    load: () => parseWorktreeSetsFile(data),
  };
  vi.spyOn(
    BaseCommand.prototype as unknown as { getSetStore: () => SetStore },
    'getSetStore',
  ).mockReturnValue(store);
}

/**
 * Spy `getGitRunner` to a canned runner: `branches` maps repoPath → current
 * branch (unknown paths report 'main'), `porcelain` is the status output
 * (default clean), and any path in `nonCheckouts` fails `revParseVerify`.
 */
export function spyGitRunner(
  opts: { branches?: Record<string, string>; porcelain?: string; nonCheckouts?: string[] } = {},
): void {
  const fake: Partial<GitRunner> = {
    branchShowCurrent: async (repoPath: string) => opts.branches?.[repoPath] ?? 'main',
    statusPorcelain: async () => opts.porcelain ?? '',
    revParseVerify: async (repoPath: string) => !(opts.nonCheckouts ?? []).includes(repoPath),
  };
  vi.spyOn(
    BaseCommand.prototype as unknown as { getGitRunner: () => GitRunner },
    'getGitRunner',
  ).mockReturnValue(fake as GitRunner);
}

/** Pin `getPrepFreshCheck` so EVERY root reports the given prebuilt verdict. */
export function spyPrepFresh(prebuilt: boolean): void {
  vi.spyOn(
    BaseCommand.prototype as unknown as { getPrepFreshCheck: () => (root: string) => boolean },
    'getPrepFreshCheck',
  ).mockReturnValue(() => prebuilt);
}

/**
 * Spy `getSlotActiveProbe` so exactly the named projects (e.g. 'soa-s2')
 * report active. Pass `[]` to pin the probe INACTIVE so no test ever consults
 * docker/state dirs. Re-callable inside a test to override the value a
 * beforeEach installed (vitest returns the existing spy on a re-spy).
 */
export function spySlotActive(activeProjects: string[]): void {
  const probe: SlotActiveProbe = {
    isActive: async (_state, project) => activeProjects.includes(project),
  };
  vi.spyOn(
    BaseCommand.prototype as unknown as { getSlotActiveProbe: () => SlotActiveProbe },
    'getSlotActiveProbe',
  ).mockReturnValue(probe);
}

/** What a `makeProbeCommand` class exposes to the tests. */
export interface ProbeCommandClass {
  /** The post-injection parsed flag bag from the most recent run. */
  captured: Record<string, unknown>;
  run(argv: string[], config: Config): Promise<unknown>;
}

/**
 * Zero-IO probe command factory unifying the set-flag suite's SetProbe and
 * the set-preflight suite's PreflightProbe: always slot-aware, records the
 * post-injection parsed flags on the static `captured` — every real command
 * reads the same parsed bag, so what the probe sees is what up/status/e2e/…
 * see. Each divergence between the two originals is an EXPLICIT option:
 *
 * - `setAware`     — whether the central --set guard admits the command.
 * - `allowPrimary` — define the `--allow-primary` boolean flag (default
 *                    false), as `stack up`/`e2e run` do.
 * - `preflight`    — run the M13-B `runSetPreflight` after parsing (parse +
 *                    preflight, nothing else). Keep false to probe the
 *                    parse-choke-point injection alone.
 */
export function makeProbeCommand(opts: {
  setAware?: boolean;
  allowPrimary?: boolean;
  preflight?: boolean;
}): ProbeCommandClass {
  const { setAware = true, allowPrimary = false, preflight = false } = opts;

  class ProbeCommand extends BaseCommand {
    static flags = {
      ...BaseCommand.baseFlags,
      ...(allowPrimary ? { 'allow-primary': Flags.boolean({ default: false }) } : {}),
    };

    static captured: Record<string, unknown> = {};

    protected slotAware(): boolean {
      return true;
    }

    protected setAware(): boolean {
      return setAware;
    }

    async run(): Promise<void> {
      const { flags } = await this.parse(ProbeCommand);
      ProbeCommand.captured = flags as Record<string, unknown>;
      if (preflight) await this.runSetPreflight(flags);
    }
  }

  return ProbeCommand as unknown as ProbeCommandClass;
}

/**
 * The single-repo store shape repeated verbatim across the check/preflight
 * tests: one set `x` on slot 1 pinning only saga-dash at `path`.
 */
export function oneSetWithSagaDash(path: string): unknown {
  return { version: 1, sets: { x: { slot: 1, repos: { 'saga-dash': path } } } };
}

/**
 * The cross-set collision fixture: sets `a`@1 and `b`@2 both pinning
 * rostering at the SAME checkout `path`.
 */
export function twoSetsSharingCheckout(path: string): unknown {
  return {
    version: 1,
    sets: {
      a: { slot: 1, repos: { rostering: path } },
      b: { slot: 2, repos: { rostering: path } },
    },
  };
}
