/**
 * `saga-stack stack wipe` — pristine-reset ONE slot 1..9 (soa#340), or every
 * non-empty slot at once via `--slot all` (soa#351).
 *
 * Where `stack down` stops a slot's services (volumes preserved) and `stack cold-start`
 * factory-resets the WHOLE slot-0 baseline, `wipe` makes a single isolated slot vanish:
 *
 *   a. STOP NATIVES  — `stopServices(stateDir)` (down's exact runtime path): SIGTERM→grace→
 *                      SIGKILL of exactly the pids native `up` recorded under the slot's
 *                      state dir. Never a host-global `pkill`.
 *   b. DOCKER -v     — `docker compose … -p soa-s<N> down --volumes --remove-orphans` via the
 *                      existing project-scoped `DockerWipe` seam: the slot's mesh CONTAINERS
 *                      **and their volumes (the DB data)** are gone. NOT `meshDown` (that is
 *                      `make down` with no `-v` — volumes would survive).
 *   c. STATE DIR     — `rm -rf /tmp/sds-synthetic-s<N>`: pids, logs, cookies.txt AND
 *                      `claim.json`, so the slot vanishes from `stack slots` (a set-bound
 *                      slot keeps its set row). NOTE: this deliberately breaks claim.ts's
 *                      "nothing ever deletes claim.json" invariant — the wipe deletes the
 *                      whole state dir, claim included, by design.
 *   d. SNAPSHOTS     — ONLY with `--snapshots`, also `rm -rf ~/.saga-mesh/snapshots-s<N>`.
 *                      Default KEEPS snapshots (they are the slot's expensive restore points).
 *
 * NEVER touches source checkouts/worktrees — no git operations at all (worktree removal
 * stays `ss set rm --and-worktrees`).
 *
 * `--slot all` (soa#351) sweeps slots 1..9 and runs the same per-slot teardown on every
 * NON-EMPTY one — a slot is a candidate iff its state dir exists, the slot is live
 * (pids/containers — the SlotActiveProbe), or (`--snapshots` only) its snapshot root
 * exists. Slot 0 is never a candidate. A live-claimed candidate is SKIPPED with a
 * warning instead of aborting the sweep (the single-slot hard refusal would strand the
 * rest); `--yes` includes it. `--set` and `--state-dir` are ambiguous with `all` and
 * rejected. CLAIM WRINKLE: BaseCommand's central claim hook resolves a non-numeric
 * `--slot` to slot 0 — in all-mode it is suppressed (`claimsSlot()` ⇒ false) and run()
 * writes a per-slot claim itself before each teardown, so a failed wipe still records
 * who attempted it and slot 0's claim is never clobbered.
 *
 * GUARDS:
 *   - slot 0 (including a bare invocation — `--slot` defaults to 0) is REFUSED with a
 *     pointer to `stack cold-start`; an explicit `--slot 1..9`, `--slot all`, or
 *     `--set <name>` (the set owns its slot) is required. Non-zero exit.
 *   - live-claim guard: if the slot's PRIOR `claim.json` records a pid that is still alive
 *     (and isn't this process's own claim), another driver is running — refuse ("claimed by
 *     <actor> <age> ago and still running"); `--yes` overrides. Stale claims never block.
 *     The prior claim is captured in a `parse` override BEFORE BaseCommand's central claim
 *     hook overwrites `claim.json` with THIS invocation's claim (see `parse` below).
 *   - destructive confirm: a plain run enumerates exactly what dies (compose project,
 *     state dir, snapshots posture, set-binding notice) and prompts once; `--yes` skips;
 *     `--dry-run` prints the same enumeration and exits 0 — and, because dry-run
 *     suppression is central in BaseCommand's claim hook, WITHOUT the claim write.
 *
 *   ss stack wipe --slot 2 --dry-run       # preview, change nothing
 *   ss stack wipe --slot 2                 # prompt, then wipe slot 2 (snapshots kept)
 *   ss stack wipe --set my-set --yes       # non-interactive (agent/CI); set supplies the slot
 *   ss stack wipe --slot 3 --snapshots     # also drop ~/.saga-mesh/snapshots-s3
 *   ss stack wipe --slot all --dry-run     # enumerate every non-empty slot 1..9
 *   ss stack wipe --slot all --yes         # wipe them all (live-claimed slots included)
 */

import { Flags } from '@oclif/core';
import type { Interfaces } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { deriveInstance } from '../../core/derive-instance.js';
import type { InstanceProfile } from '../../core/derive-instance.js';
import { SET_REPO_KEYS } from '../../core/set/index.js';
import type { SetRepoKey, WorktreeSet } from '../../core/set/index.js';
import {
  composeDownVArgs,
  relativeAge,
  repoContextFromFlags,
  resolveRepoRoot,
  REPO_ENV_VAR,
} from '../../runtime/index.js';
import type { ClaimReadResult, StopServiceResult } from '../../runtime/index.js';

/**
 * `--slot` for wipe ONLY: the base integer 0..9 (`shared-flags.ts` semantics) OR the
 * literal `all` (soa#351). Overriding here keeps the shared flag an integer everywhere
 * else — no other command accepts `all`.
 */
const slotOrAll = Flags.custom<number | 'all'>({
  default: 0,
  description:
    "slot to wipe: 1..9 (an isolated soa-s<N> sub-stack), or 'all' to wipe every non-empty " +
    'slot 1..9. Slot 0 (the default) is refused — the shared baseline resets via `stack cold-start`.',
  parse: async (input: string) => {
    if (input === 'all') return 'all';
    const n = Number(input);
    if (!Number.isInteger(n) || n < 0 || n > 9) {
      throw new Error("--slot must be an integer 0..9 or 'all'");
    }
    return n;
  },
});

/** The per-slot outcome record shared by the single-slot emit and the all-mode summary. */
interface WipeOutcome {
  slot: number;
  project: string;
  stateDir: string;
  stopped: number;
  volumesRemoved: boolean;
  stateDirRemoved: boolean;
  snapshotsRemoved: boolean;
}

export default class StackWipe extends BaseCommand {
  static description =
    'Pristine-reset ONE slot (1..9) or --slot all (every non-empty slot): stop its native services, ' +
    'docker compose -p soa-s<N> down -v (containers + volumes), rm -rf its state dir; --snapshots also ' +
    'removes ~/.saga-mesh/snapshots-s<N>. Never touches source checkouts. Destructive; requires an ' +
    'explicit --slot 1..9, --slot all, or --set.';

  static examples = [
    '<%= config.bin %> <%= command.id %> --slot 2 --dry-run',
    '<%= config.bin %> <%= command.id %> --slot 2',
    '<%= config.bin %> <%= command.id %> --set my-set --yes',
    '<%= config.bin %> <%= command.id %> --slot 3 --snapshots --yes',
    '<%= config.bin %> <%= command.id %> --slot all --dry-run',
    '<%= config.bin %> <%= command.id %> --slot all --yes',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    slot: slotOrAll(),
    'dry-run': Flags.boolean({
      description:
        'print exactly what would die (containers/volumes, state dir, snapshots posture) and exit 0 without touching anything — no claim is written.',
      default: false,
    }),
    yes: Flags.boolean({
      description:
        'non-interactive: skip the destructive-action prompt AND override the live-claim guard (CI / agents). ' +
        'With --slot all, also INCLUDES live-claimed slots the sweep would otherwise skip.',
      default: false,
    }),
    snapshots: Flags.boolean({
      description:
        "ALSO rm -rf the slot's snapshot root (~/.saga-mesh/snapshots-s<N>); default keeps snapshots.",
      default: false,
    }),
  };

  /** `wipe --slot N` tears down exactly one isolated slot 1..9 (slot 0 is refused in run). */
  protected slotAware(): boolean {
    return true;
  }

  /** M13-A: `--set` resolves to the set's slot; wipe resets that slot (checkouts untouched). */
  protected setAware(): boolean {
    return true;
  }

  /**
   * Slot claims: a wipe DRIVES the slot — a FAILED wipe usefully records who attempted;
   * a successful one deletes the claim along with the state dir (step c). SUPPRESSED in
   * all-mode: the central hook resolves a non-numeric `--slot` to slot 0 and would
   * clobber slot 0's claim; `runAll` writes a per-slot claim itself instead.
   */
  protected claimsSlot(): boolean {
    return !this.allMode;
  }

  /** `--slot all` detected from the raw argv in `parse` (before flag parsing). */
  private allMode = false;

  /**
   * The prior driver's claim per state dir, captured BEFORE BaseCommand's claim hook
   * overwrites `claim.json` with this invocation's own claim (see `parse`).
   */
  private priorClaims = new Map<string, ClaimReadResult>();

  /**
   * CLAIM-ORDERING WRINKLE (soa#340): with `claimsSlot() ⇒ true`, BaseCommand.parse
   * writes THIS invocation's claim to `<stateDir>/claim.json` BEFORE `run()` executes —
   * so a naive `getClaimReader().read(stateDir)` in run() would see wipe's OWN live
   * claim, and the prior driver's claim (the one the live-claim guard needs) would
   * already be destroyed. Capture the pre-existing claims here, before delegating to
   * super.parse. The candidate state dirs are deterministic (slots 1..9) plus any raw
   * `--state-dir` token, so no flag parsing is needed to enumerate them. The same raw
   * scan detects `--slot all` (soa#351) so `claimsSlot()` can suppress the central
   * hook before it runs.
   */
  protected async parse<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    F extends { [flag: string]: any },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    B extends { [flag: string]: any },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    A extends { [arg: string]: any },
  >(
    options?: Interfaces.Input<F, B, A>,
    argv?: string[],
  ): Promise<Interfaces.ParserOutput<F, B, A>> {
    const raw = argv ?? this.argv;
    this.allMode = StackWipe.hasAllToken(raw);
    this.capturePriorClaims(raw);
    return super.parse<F, B, A>(options, argv);
  }

  /** Raw-argv detection of `--slot all` / `--slot=all` (runs before oclif parsing). */
  private static hasAllToken(rawArgv: readonly string[]): boolean {
    for (let i = 0; i < rawArgv.length; i++) {
      const token = rawArgv[i];
      if (token === '--slot' && rawArgv[i + 1] === 'all') return true;
      if (token === '--slot=all') return true;
    }
    return false;
  }

  /** Read (and remember) the current claim of every candidate state dir. Reads only — never writes. */
  private capturePriorClaims(rawArgv: readonly string[]): void {
    const reader = this.getClaimReader();
    const dirs = new Set<string>();
    // Slot 0 is refused before any destruction, so only 1..9 need their prior claim.
    for (let slot = 1; slot <= 9; slot++) dirs.add(deriveInstance({ slot }).stateDir);
    for (let i = 0; i < rawArgv.length; i++) {
      const token = rawArgv[i];
      if (token === undefined) continue;
      const next = rawArgv[i + 1];
      if (token === '--state-dir' && next !== undefined) dirs.add(next);
      else if (token.startsWith('--state-dir=')) dirs.add(token.slice('--state-dir='.length));
    }
    for (const dir of dirs) {
      const result = reader.read(dir);
      if (result !== null) this.priorClaims.set(dir, result);
    }
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(StackWipe);
    const dry = flags['dry-run'];
    // Suppress the human step lines under --output-json/--porcelain so machine
    // output stays parseable; warnings still go to stderr via this.warn.
    const human = !flags['output-json'] && !flags.porcelain;

    // oclif infers the parsed flag bag from `flags` AND the inherited `baseFlags`,
    // and the base integer `slot` collapses the union to `number` (overriding
    // `static baseFlags` is a TS2417 static-side violation) — re-widen once here;
    // the runtime value is exactly what slotOrAll's parser returned.
    const slot = flags.slot as number | 'all';

    if (slot === 'all') {
      // `--set` + `--slot all` already died in the central set-injection guard
      // (a typed --slot that disagrees with the set's slot is a hard error).
      if (flags['state-dir'] !== undefined) {
        this.error(
          "--state-dir pins ONE slot's state and is ambiguous with --slot all — drop one of them.",
        );
      }
      await this.runAll(flags, dry, human);
      return;
    }

    // ── GUARD: slot 0 / bare invocation refused (non-zero). `--slot` defaults to 0, so a
    // bare `ss stack wipe` lands here too; `--set` always passes (a set is bound to 1..9,
    // and its slot was injected into flags.slot during parse — "the set owns its slot").
    if (slot === 0) {
      this.error(
        'stack wipe pristine-resets isolated slots and requires an explicit --slot 1..9, ' +
          '--slot all, or --set <name>. Slot 0 is the shared baseline — use `ss stack cold-start` to reset it.',
      );
    }

    const profile = deriveInstance({ slot });
    // Mirror down/up's resolution: an EXPLICIT --state-dir wins (that's where up recorded
    // the pids), otherwise the slot's canonical /tmp/sds-synthetic-s<N>.
    const stateDir = flags['state-dir'] ?? profile.stateDir;

    // ── GUARD: live prior claim ⇒ another driver is running this slot right now. The
    // PRIOR claim was captured in parse() before the central hook overwrote claim.json
    // with our own; our own pid never blocks. Stale claims (dead pid) never block. On
    // --dry-run nothing is destroyed, so just surface the fact instead of refusing.
    const prior = this.priorClaims.get(stateDir);
    const foreignLive = prior !== undefined && prior.live && prior.claim.pid !== process.pid;
    if (foreignLive && !dry && !flags.yes) {
      this.error(
        `slot ${profile.slot}: claimed by ${prior.claim.actor} ${relativeAge(prior.claim.at)} ago ` +
          `and still running (pid ${prior.claim.pid} — \`${prior.claim.command}\`). ` +
          'Refusing to wipe under a live driver; pass --yes to override.',
      );
    }

    // ── enumerate exactly what dies (guard i) + set-binding notice (guard ii) ──
    const set = this.ownerSet(profile.slot);
    const withSnapshots = flags.snapshots;
    const plan = this.planLines(profile, stateDir, withSnapshots, set);

    if (dry) {
      // Same enumeration, zero side effects — parse's central hook already suppressed
      // the claim write for --dry-run, so this path touches NOTHING.
      this.log(`▶ stack wipe DRY RUN — slot ${profile.slot} (nothing will be changed):`);
      for (const line of plan) this.log(line);
      const ctx = repoContextFromFlags(flags as unknown as Record<string, unknown>);
      const soaRoot = resolveRepoRoot('SOA', ctx);
      this.log(
        `    would run (in ${soaRoot}/infra): docker ${composeDownVArgs(profile.project).join(' ')}`,
      );
      if (foreignLive) {
        this.log(
          `    note: slot is live-claimed by ${prior.claim.actor} ` +
            `(${relativeAge(prior.claim.at)} ago) — a real run will refuse without --yes.`,
        );
      }
      this.log('✓ wipe dry run complete — no changes made.');
      return;
    }

    if (!flags.yes) {
      // The enumeration + one prompt run even under --output-json/--porcelain — a
      // destructive command never proceeds silently; agents pass --yes for clean output.
      this.log(`▶ stack wipe — slot ${profile.slot} (pristine reset):`);
      for (const line of plan) this.log(line);
      const ok = await this.getConfirm().prompt(
        `\n  This DESTROYS slot ${profile.slot}'s containers, DB volumes, and run state` +
          `${withSnapshots ? ' AND its snapshots' : ''}. Continue? [y/N] `,
      );
      if (!ok) {
        // A declined prompt is an abort, not a refusal — exit 0, nothing changed
        // (cold-start's convention; the spec's non-zero refusals are slot 0,
        // live claim without --yes, and missing --slot/--set).
        this.log('wipe aborted — nothing changed.');
        return;
      }
    } else if (human) {
      this.log(`▶ stack wipe — slot ${profile.slot} (pristine reset, --yes):`);
      for (const line of plan) this.log(line);
    }

    const outcome = await this.teardownSlot(profile, stateDir, withSnapshots, flags, human, '');

    this.emit(
      flags,
      { ...outcome },
      `✓ slot ${profile.slot} wiped — ${profile.project} down -v'd, ${stateDir} removed` +
        (withSnapshots ? ', snapshots removed.' : ' (snapshots kept).'),
    );
  }

  /**
   * `--slot all` (soa#351): sweep slots 1..9 and wipe every non-empty one. Candidacy is
   * cheap and local — state dir on disk, live activity (the same probe `stack slots`
   * trusts), or (only when they are in scope via `--snapshots`) a snapshot root. A
   * live-claimed candidate is skipped with a warning rather than aborting the sweep;
   * `--yes` includes it.
   */
  private async runAll(
    flags: {
      yes: boolean;
      snapshots: boolean;
      porcelain: boolean;
      'output-json': boolean;
      [k: string]: unknown;
    },
    dry: boolean,
    human: boolean,
  ): Promise<void> {
    const remover = this.getSlotWipe();
    const probe = this.getSlotActiveProbe();
    const withSnapshots = flags.snapshots;

    const candidates: InstanceProfile[] = [];
    const skipped: { profile: InstanceProfile; prior: ClaimReadResult }[] = [];
    for (let slot = 1; slot <= 9; slot++) {
      const profile = deriveInstance({ slot });
      const nonEmpty =
        remover.exists(profile.stateDir) ||
        (await probe.isActive(profile.stateDir, profile.project)) ||
        (withSnapshots && profile.snapshotsDir !== undefined && remover.exists(profile.snapshotsDir));
      if (!nonEmpty) continue;
      const prior = this.priorClaims.get(profile.stateDir);
      const foreignLive = prior !== undefined && prior.live && prior.claim.pid !== process.pid;
      if (foreignLive && !flags.yes) {
        skipped.push({ profile, prior });
        continue;
      }
      candidates.push(profile);
    }

    const skipLine = ({ profile, prior }: { profile: InstanceProfile; prior: ClaimReadResult }): string =>
      `slot ${profile.slot}: live-claimed by ${prior.claim.actor} (${relativeAge(prior.claim.at)} ago, ` +
      `pid ${prior.claim.pid} still running) — skipped; pass --yes to include it.`;

    if (candidates.length === 0) {
      for (const s of skipped) this.warn(skipLine(s));
      const message =
        skipped.length === 0
          ? '✓ nothing to wipe — no non-empty slots (1..9).'
          : `✓ nothing wiped — ${skipped.length} non-empty slot(s) live-claimed (--yes includes them).`;
      if (dry) {
        this.log(message);
        return;
      }
      this.emit(flags, { mode: 'all', wiped: [], skipped: skipped.map((s) => s.profile.slot) }, message);
      return;
    }

    // ── the sweep enumeration: every candidate's full plan, then the skips ──
    const header = dry
      ? `▶ stack wipe DRY RUN — ALL non-empty slots (nothing will be changed):`
      : `▶ stack wipe — ALL non-empty slots (pristine reset${flags.yes ? ', --yes' : ''}):`;
    if (human || !flags.yes || dry) this.log(header);
    for (const profile of candidates) {
      this.log(`  slot ${profile.slot}:`);
      const set = this.ownerSet(profile.slot);
      for (const line of this.planLines(profile, profile.stateDir, withSnapshots, set)) this.log(line);
    }
    for (const s of skipped) {
      if (dry) this.log(`  note: ${skipLine(s)}`);
      else this.warn(skipLine(s));
    }

    if (dry) {
      this.log('✓ wipe dry run complete — no changes made.');
      return;
    }

    if (!flags.yes) {
      const ok = await this.getConfirm().prompt(
        `\n  This DESTROYS ${candidates.length} slot(s) (${candidates.map((p) => p.slot).join(', ')}): ` +
          `containers, DB volumes, and run state${withSnapshots ? ' AND snapshots' : ''}. Continue? [y/N] `,
      );
      if (!ok) {
        this.log('wipe aborted — nothing changed.');
        return;
      }
    }

    // Per-slot advisory claim (the central hook is suppressed in all-mode — it would
    // resolve `all` to slot 0): written before each teardown so a failed wipe still
    // records who attempted it; a successful one deletes it with the state dir.
    const ctx = repoContextFromFlags(flags as unknown as Record<string, unknown>);
    const repoRoots: Partial<Record<SetRepoKey, string>> = {};
    for (const repo of SET_REPO_KEYS) repoRoots[repo] = resolveRepoRoot(REPO_ENV_VAR[repo], ctx);
    const command = [this.config.bin, this.id, ...this.argv].join(' ');

    const wiped: WipeOutcome[] = [];
    for (const profile of candidates) {
      await this.getClaimWriter().write({
        slot: profile.slot,
        stateDir: profile.stateDir,
        command,
        repoRoots,
      });
      wiped.push(
        await this.teardownSlot(
          profile,
          profile.stateDir,
          withSnapshots,
          flags,
          human,
          `slot ${profile.slot} · `,
        ),
      );
    }

    this.emit(
      flags,
      { mode: 'all', wiped, skipped: skipped.map((s) => s.profile.slot) },
      `✓ ${wiped.length} slot(s) wiped — ${wiped.map((w) => w.project).join(', ')} down -v'd, state dirs removed` +
        (withSnapshots ? ', snapshots removed' : ' (snapshots kept)') +
        (skipped.length > 0 ? `; ${skipped.length} live-claimed slot(s) skipped.` : '.'),
    );
  }

  /**
   * Steps a–d for ONE slot — the shared teardown behind both the single-slot path and
   * the `--slot all` sweep. `tag` prefixes the human step lines (`''` single-slot,
   * `slot <N> · ` in a sweep) so single-slot output stays byte-identical to soa#340.
   */
  private async teardownSlot(
    profile: InstanceProfile,
    stateDir: string,
    withSnapshots: boolean,
    flags: { [k: string]: unknown },
    human: boolean,
    tag: string,
  ): Promise<WipeOutcome> {
    const total = withSnapshots ? 4 : 3;

    // ── (a) stop the slot's services natively (down's exact runtime path) ──
    if (human) this.log(`▶ ${tag}1/${total} services — stop natives recorded under ${stateDir} (kill-by-pidfile)`);
    const stopResults: StopServiceResult[] = await this.getServiceStopper()(stateDir);
    const stoppedList = stopResults.filter((s) => s.outcome === 'term' || s.outcome === 'kill');
    const survived = stopResults.filter((s) => s.outcome === 'alive');
    if (human) {
      this.log(
        `  ✓ stopped ${stoppedList.length} service(s)` +
          (stoppedList.length > 0
            ? `: ${stoppedList.map((s) => `${s.id}${s.outcome === 'kill' ? ' (SIGKILL)' : ''}`).join(', ')}`
            : ' (none running)'),
      );
    }
    if (survived.length > 0) {
      // The state-dir rm below deletes these survivors' pidfiles — they would leak
      // invisibly. Warn LOUD (stderr, so json/porcelain stdout stays clean).
      this.warn(
        `${survived.length} service(s) STILL ALIVE after SIGTERM+SIGKILL — their pidfiles die with the ` +
          `state dir, leaking them: ${survived
            .map((s) => `${s.id}${s.pid !== undefined ? ` (pid ${s.pid})` : ''}`)
            .join(', ')}`,
      );
    }

    // ── (b) docker compose -p soa-s<N> down -v (containers + volumes) — the existing
    // project-scoped DockerWipe seam; NEVER systemPrune (host-global) from here. ──
    if (human) this.log(`▶ ${tag}2/${total} docker — compose -p ${profile.project} down -v (containers + volumes)`);
    const ctx = repoContextFromFlags(flags as unknown as Record<string, unknown>);
    const soaRoot = resolveRepoRoot('SOA', ctx);
    const down = await this.getDockerWipe().composeDownVolumes({
      soaRoot,
      project: profile.project,
    });
    const volumesRemoved = down.ok;
    if (down.ok) {
      if (human) this.log(`  ✓ ${profile.project} containers + volumes removed`);
    } else {
      this.warn(
        `compose down -v exited ${down.code} — ${profile.project} volumes may remain ` +
          '(mesh already gone, or docker unavailable); continuing with the state-dir wipe.',
      );
    }

    // ── (c) rm -rf the slot's state dir (pids/logs/cookies/claim.json) ──
    if (human) this.log(`▶ ${tag}3/${total} state — rm -rf ${stateDir}`);
    const remover = this.getSlotWipe();
    const stateDirRemoved = remover.remove(stateDir);
    if (human) {
      this.log(
        stateDirRemoved
          ? `  ✓ state dir removed — slot ${profile.slot} vanishes from \`stack slots\``
          : `  · state dir not removed (${stateDir} absent, or not removable)`,
      );
    }

    // ── (d) --snapshots only: rm -rf ~/.saga-mesh/snapshots-s<N> (default keeps them) ──
    let snapshotsRemoved = false;
    if (withSnapshots && profile.snapshotsDir !== undefined) {
      if (human) this.log(`▶ ${tag}4/${total} snapshots — rm -rf ${profile.snapshotsDir}`);
      snapshotsRemoved = remover.remove(profile.snapshotsDir);
      if (human) {
        this.log(
          snapshotsRemoved
            ? '  ✓ snapshots removed'
            : `  · snapshots not removed (${profile.snapshotsDir} absent, or not removable)`,
        );
      }
    }

    return {
      slot: profile.slot,
      project: profile.project,
      stateDir,
      stopped: stoppedList.length,
      volumesRemoved,
      stateDirRemoved,
      snapshotsRemoved,
    };
  }

  /**
   * Reverse-lookup the worktree set that owns this slot (slots are schema-unique
   * across sets — set create's guard), for the set-binding notice. A corrupt sets
   * file degrades to "no notice" rather than killing the wipe (slots.ts's stance).
   */
  private ownerSet(slot: number): WorktreeSet | undefined {
    try {
      return Object.values(this.getSetStore().load().sets).find((s) => s.slot === slot);
    } catch {
      return undefined;
    }
  }

  /** The destruction enumeration — identical for the confirm header and --dry-run (guard i). */
  private planLines(
    profile: InstanceProfile,
    stateDir: string,
    withSnapshots: boolean,
    set: WorktreeSet | undefined,
  ): string[] {
    const lines = [
      `    services:  stop native dev servers recorded under ${stateDir} (kill-by-pidfile)`,
      `    docker:    compose -p ${profile.project} down -v — containers AND volumes (DB data)`,
      `    state:     rm -rf ${stateDir} (pids/logs/cookies/claim.json — the slot vanishes from \`stack slots\`)`,
      withSnapshots
        ? `    snapshots: rm -rf ${profile.snapshotsDir}`
        : `    snapshots: KEPT (${profile.snapshotsDir}) — pass --snapshots to remove them too`,
    ];
    if (set !== undefined) {
      // Guard (ii): the set-binding notice — checkouts are sacred (guard 3).
      lines.push(
        `    set:       slot ${profile.slot} is owned by set '${set.name}' — its worktrees/checkouts are ` +
          'NOT touched (worktree removal is `ss set rm --and-worktrees`)',
      );
    }
    return lines;
  }
}
