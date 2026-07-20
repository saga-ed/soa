/**
 * `saga-stack stack slots` — who is on what slot (slot claims; read-only glance).
 *
 * One row per slot 0-9 that is ACTIVE (the live `SlotActiveProbe` — state-dir pid
 * liveness OR running `soa[-s<N>]` compose containers), CLAIMED
 * (`<stateDir>/claim.json`), or SET-BOUND (a worktree set owns the slot); slots
 * with none of the three collapse into one dim summary line. claim.json is
 * ADVISORY "who last drove this slot" state — the deliberate counterpart to
 * slot-active.ts's "no recorded active state" stance: ACTIVITY is always derived
 * live (nothing to go stale), while the claim is recorded history a stack
 * outlives by design ("last driven by", not a lock). Claim staleness is derived
 * at READ time from the recorded pid's liveness (`live`/`stale`), and nothing
 * ever deletes claim.json — a stale claim on an inactive slot is normal history,
 * not an error.
 *
 * ACTIVE slots additionally get a per-repo source POSTURE (branch / dirty /
 * behind-origin — `set show`'s exact mainline-currency recipe, as-of the last
 * fetch) plus drift-since-launch (the claim's recorded HEAD vs the checkout's
 * HEAD now). Posture is probed ONLY for active slots (cost control): a set-bound
 * slot postures the set's pinned repos; slot 0 postures every shared checkout
 * that exists; an active slot > 0 WITHOUT a set runs the shared checkouts too,
 * so it postures nothing and points at slot 0 instead (no git spawns).
 *
 * READ-ONLY: always reports ALL slots 0-9 (`--slot` is accepted but does not
 * narrow the report); never exits non-zero.
 *
 *   node bin/dev.js stack slots
 *   node bin/dev.js stack slots --output-json
 */

import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { cyan, dim, yellow } from '../../color.js';
import { deriveInstance } from '../../core/derive-instance.js';
import { SET_REPO_KEYS, emptyWorktreeSetsFile } from '../../core/set/index.js';
import type {
  SetRepoEntry,
  SetRepoKey,
  WorktreeSet,
  WorktreeSetsFile,
} from '../../core/set/index.js';
import {
  REPO_ENV_VAR,
  hasTrackedChanges,
  repoContextFromFlags,
  resolveRepoRoot,
} from '../../runtime/index.js';
import type { ClaimReadResult, GitRunner } from '../../runtime/index.js';

/** The posture note rendered for an active slot > 0 with no set (shared checkouts). */
const POSTURE_SKIPPED_SHARED = 'shared checkouts (see slot 0)';

export default class StackSlots extends BaseCommand {
  static description =
    'Show who is on what slot: live activity, worktree-set binding, and the last advisory claim per slot — always reports ALL slots 0-9 (read-only).';

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --porcelain',
    '<%= config.bin %> <%= command.id %> --output-json',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    // Same universal flag, slots-specific help: document THIS command's TSV shape.
    porcelain: Flags.boolean({
      description:
        'machine-readable TSV, one line per row-worthy slot (active, claimed, or set-bound): ' +
        'slot ⇥ active|- ⇥ set|- ⇥ actor|- ⇥ live|stale|- ⇥ at (ISO-8601)',
      default: false,
    }),
  };

  /** Accepting --slot is harmless — the report ALWAYS covers all slots 0-9. */
  protected slotAware(): boolean {
    return true;
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(StackSlots);

    // Every slot 0-9, unconditionally (the verify --all-slots sweep's shape).
    const profiles = Array.from({ length: 10 }, (_, slot) => deriveInstance({ slot }));

    const probe = this.getSlotActiveProbe();
    // A corrupt/hand-edited sets file must not kill the glance — the activity
    // and claim halves don't depend on it ("never exits non-zero").
    let file: WorktreeSetsFile;
    try {
      file = this.getSetStore().load();
    } catch (error) {
      this.warn(
        `worktree-sets file unreadable — reporting without set bindings (${error instanceof Error ? error.message : String(error)})`,
      );
      file = emptyWorktreeSetsFile();
    }
    const reader = this.getClaimReader();
    const slots = await Promise.all(
      profiles.map(async (profile) => ({
        profile,
        active: await probe.isActive(profile.stateDir, profile.project),
        // Reverse lookup — slots are schema-unique across sets (set create's guard).
        set: Object.values(file.sets).find((s) => s.slot === profile.slot),
        claim: reader.read(profile.stateDir),
      })),
    );

    // A slot gets a row iff it is active, claimed, or set-bound; the rest collapse.
    const worthy = slots.filter((s) => s.active || s.claim !== null || s.set !== undefined);
    const unused = slots.filter((s) => !worthy.includes(s)).map((s) => s.profile.slot);

    const git = this.getGitRunner();
    const ctx = repoContextFromFlags(flags as unknown as Record<string, unknown>);
    const dirExists = this.getRepoDirCheck();
    const rows = await Promise.all(
      worthy.map(async (s): Promise<SlotRow> => {
        let posture: PostureRow[] = [];
        let postureSkipped: string | undefined;
        // Posture is probed for ACTIVE slots only (cost control — git spawns).
        if (s.active) {
          if (s.set !== undefined) {
            const entries = (Object.entries(s.set.repos) as [SetRepoKey, SetRepoEntry][]).map(
              ([repo, entry]) => ({ repo, root: entry.path }),
            );
            posture = await readPosture(entries.filter((e) => dirExists(e.root)), git, s.claim);
          } else if (s.profile.slot === 0) {
            const entries = SET_REPO_KEYS.map((repo) => ({
              repo,
              root: resolveRepoRoot(REPO_ENV_VAR[repo], ctx),
            }));
            posture = await readPosture(entries.filter((e) => dirExists(e.root)), git, s.claim);
          } else {
            // An active slot > 0 with no set runs the shared checkouts — their
            // posture belongs to slot 0's rows; probing here would double the spawns.
            postureSkipped = POSTURE_SKIPPED_SHARED;
          }
        }
        return {
          slot: s.profile.slot,
          active: s.active,
          project: s.profile.project,
          stateDir: s.profile.stateDir,
          set: s.set,
          claim: s.claim,
          posture,
          postureSkipped,
        };
      }),
    );

    if (flags['output-json']) {
      this.log(
        JSON.stringify(
          {
            slots: rows.map((r) => ({
              slot: r.slot,
              active: r.active,
              project: r.project,
              stateDir: r.stateDir,
              set: r.set?.name ?? null,
              claim:
                r.claim === null
                  ? null
                  : {
                      actor: r.claim.claim.actor,
                      actorSource: r.claim.claim.actorSource,
                      live: r.claim.live,
                      at: r.claim.claim.at,
                      pid: r.claim.claim.pid,
                      command: r.claim.claim.command,
                      ...(r.claim.claim.set !== undefined ? { set: r.claim.claim.set } : {}),
                    },
              posture: r.posture.map((p) => ({
                repo: p.repo,
                branch: p.branch,
                dirty: p.dirty,
                behind: p.behind,
                driftedSinceLaunch: p.driftedSinceLaunch,
                ...(p.notCheckout === true ? { notCheckout: true } : {}),
              })),
              ...(r.postureSkipped !== undefined ? { postureSkipped: r.postureSkipped } : {}),
            })),
          },
          null,
          2,
        ),
      );
      return;
    }

    if (rows.length === 0) {
      if (!flags.porcelain) {
        this.log('No slots in use — nothing active, no claims, no sets (slots 0-9 all idle).');
      }
      return;
    }

    if (flags.porcelain) {
      for (const r of rows) {
        this.log(
          [
            String(r.slot),
            r.active ? 'active' : '-',
            r.set?.name ?? '-',
            r.claim?.claim.actor ?? '-',
            r.claim === null ? '-' : r.claim.live ? 'live' : 'stale',
            r.claim?.claim.at ?? '-',
          ].join('\t'),
        );
      }
      return;
    }

    const setW = Math.max(3, ...rows.map((r) => (r.set?.name ?? '—').length));
    const actorW = Math.max(5, ...rows.map((r) => actorText(r).length));
    const header = `SLOT  ACTIVE  ${'SET'.padEnd(setW)}  ${'ACTOR'.padEnd(actorW)}  LAST DRIVEN`;
    this.log(header);
    this.log('─'.repeat(header.length));
    const now = Date.now();
    rows.forEach((r, i) => {
      if (i > 0) this.log(''); // one blank line between slot blocks
      this.log(
        `${String(r.slot).padEnd(4)}  ${(r.active ? '● up' : '—').padEnd(6)}  ` +
          `${(r.set?.name ?? '—').padEnd(setW)}  ${renderActor(r, actorW)}  ` +
          `${r.claim === null ? '—' : relativeAge(r.claim.claim.at, now)}`,
      );
      if (r.postureSkipped !== undefined) this.log(dim(`      · posture: ${r.postureSkipped}`));
      // Pad branches per slot so the annotation column aligns down the block.
      const branchW = Math.max(
        0,
        ...r.posture.filter((p) => p.notCheckout !== true).map((p) => p.branch.length),
      );
      for (const p of r.posture) {
        if (p.notCheckout === true) {
          this.log(`      ${p.repo.padEnd(12)} ${yellow('not a git checkout')}`);
          continue;
        }
        const notes = [
          p.dirty ? yellow('dirty') : dim('clean'),
          ...(p.behind !== null && p.behind > 0 ? [yellow(`behind by ${p.behind}`)] : []),
          ...(p.driftedSinceLaunch ? [yellow('⚠ drifted since launch')] : []),
        ];
        this.log(`      ${p.repo.padEnd(12)} @ ${cyan(p.branch.padEnd(branchW))}   ${notes.join('  ')}`);
      }
    });
    if (unused.length > 0) {
      if (rows.length > 0) this.log('');
      this.log(dim(`slot${unused.length === 1 ? '' : 's'} ${collapseRuns(unused)}: unused`));
    }
  }
}

/** Human age of an ISO timestamp ("2h ago"); the raw string when unparseable. */
function relativeAge(at: string, now: number): string {
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return at;
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Collapse sorted slot numbers into range text: [1, 3, 5, 6, 7] → "1, 3, 5-7". */
function collapseRuns(slots: number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < slots.length; ) {
    let j = i;
    while (j + 1 < slots.length && slots[j + 1] === (slots[j] ?? Number.NaN) + 1) j++;
    parts.push(i === j ? String(slots[i]) : `${slots[i]}-${slots[j]}`);
    i = j + 1;
  }
  return parts.join(', ');
}

/** One per-repo posture reading for an active slot (set/show's currency recipe). */
interface PostureRow {
  repo: SetRepoKey;
  branch: string;
  dirty: boolean;
  /** Commits behind `origin/<default>`; 0 when the tip is contained; null = could not compare. */
  behind: number | null;
  /** The ref `behind` was measured against (human rendering only — not projected to JSON). */
  mainRef: string;
  /** The claim recorded a launch HEAD for this repo and the checkout's HEAD differs now. */
  driftedSinceLaunch: boolean;
  /** The root exists on disk but is not a git checkout (HEAD does not verify). */
  notCheckout?: boolean;
}

/** One row-worthy slot (active, claimed, or set-bound), posture attached. */
interface SlotRow {
  slot: number;
  active: boolean;
  project: string;
  stateDir: string;
  set?: WorktreeSet;
  claim: ClaimReadResult | null;
  posture: PostureRow[];
  /** Why posture was skipped (active slot > 0 with no set — shared checkouts). */
  postureSkipped?: string;
}

/** The raw (uncolored) ACTOR cell — the claim's actor, '(stale)'-suffixed when its pid is dead. */
function actorText(r: SlotRow): string {
  if (r.claim === null) return '—';
  return r.claim.claim.actor + (r.claim.live ? '' : ' (stale)');
}

/** Pad the raw ACTOR cell FIRST, then dim the '(stale)' suffix — codes are zero-width. */
function renderActor(r: SlotRow, width: number): string {
  const padded = actorText(r).padEnd(width);
  if (r.claim !== null && !r.claim.live) return padded.replace(' (stale)', dim(' (stale)'));
  return padded;
}

/**
 * Read each existing repo root's posture (Promise.all, mirroring `set show`):
 * live branch, tracked-change dirtiness, mainline currency (`origin/<default>`
 * contained ⇒ 0, else the behind count, null when the ref can't be compared),
 * and drift-since-launch against the claim's recorded HEAD.
 */
async function readPosture(
  entries: { repo: SetRepoKey; root: string }[],
  git: GitRunner,
  claim: ClaimReadResult | null,
): Promise<PostureRow[]> {
  return Promise.all(
    entries.map(async ({ repo, root }): Promise<PostureRow> => {
      // An existing dir that is NOT a git checkout must not render as
      // '@ (detached)  (clean)' — set/show's exact guard (every probe below
      // folds errors into healthy-looking answers).
      if (!(await git.revParseVerify(root, 'HEAD'))) {
        return {
          repo,
          branch: '',
          dirty: false,
          behind: null,
          mainRef: '',
          driftedSinceLaunch: false,
          notCheckout: true,
        };
      }
      const branch = (await git.branchShowCurrent(root)) || '(detached)';
      const dirty = hasTrackedChanges(await git.statusPorcelain(root));
      // Mainline currency — set/show's exact recipe (as-of the last fetch; no network).
      const mainRef = `origin/${await git.symbolicRefDefault(root)}`;
      let behind: number | null = null;
      if (await git.revParseVerify(root, mainRef)) {
        behind = (await git.isAncestorOfHead(root, mainRef))
          ? 0
          : await git.countBehindRef(root, mainRef); // null = could not compare
      }
      const launchSha = claim?.claim.sourceAtLaunch[repo]?.headSha;
      const currentSha = await git.headSha(root);
      // An empty sha on EITHER side means "unresolvable", never comparable —
      // prep-stamp's stampMatches invariant (a stored '' can never self-match).
      const driftedSinceLaunch =
        launchSha !== undefined &&
        launchSha !== '' &&
        currentSha !== '' &&
        launchSha !== currentSha;
      return { repo, branch, dirty, behind, mainRef, driftedSinceLaunch };
    }),
  );
}
