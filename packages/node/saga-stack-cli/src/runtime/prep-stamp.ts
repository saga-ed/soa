/**
 * R1 prep freshness STAMP (soa#256).
 *
 * A repo's fresh-skip must mean "built AND CURRENT," not just "artifacts present."
 * The presence-only fresh-check let R1 skip a repo that had been `git pull`ed
 * without a reinstall/rebuild, so the stack served STALE code (three misfires in
 * the 2026-07-07 flow-run session: one HEAD move, two lockfile changes). This
 * module stamps each successfully-prepped repo with its current identity and lets
 * the fresh-check reject a repo whose HEAD or lockfile has since moved.
 *
 * The stamp lives at `<repoRoot>/node_modules/.saga-stack-prep-stamp` — inside
 * `node_modules` so it is always gitignored, travels with the install, and vanishes
 * when `node_modules` is blown away (correctly forcing a reprep). Content is JSON
 * `{ headSha, lockHash }`.
 *
 * PURITY: every read folds to a safe default — an unresolvable HEAD or absent
 * lockfile is `''`, a missing/unparseable stamp is a non-match — so the fresh-check
 * never throws and any error means "not fresh ⇒ prep runs" (the pre-#256 default
 * that every fs error already folded to).
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/** The stamp file's path relative to a repo root. */
const STAMP_REL = 'node_modules/.saga-stack-prep-stamp';

/** A matches a 40-hex git object id (SHA-1). */
const SHA_RE = /^[0-9a-f]{40}$/i;

/** The freshness identity of a repo checkout: its HEAD commit + lockfile hash. */
export interface PrepFreshness {
  /** Current git HEAD sha, or `''` when unresolvable (not a checkout / any read error). */
  headSha: string;
  /** sha256 of `pnpm-lock.yaml`, or `''` when the lockfile is absent/unreadable. */
  lockHash: string;
}

/** Absolute path to a repo's stamp file. */
function stampPath(repoRoot: string): string {
  return join(repoRoot.replace(/\/+$/, ''), STAMP_REL);
}

/**
 * Resolve `.git` for a repo root, handling BOTH a normal checkout (`.git` is a
 * directory) AND a linked worktree (`.git` is a FILE holding `gitdir: <path>`).
 * Returns the worktree's own gitdir (where its `HEAD` lives) and the COMMONDIR
 * (where shared `packed-refs`/`refs` live). For a plain checkout the two coincide.
 * Throws on any unreadable/unrecognised layout (the caller folds that to `''`).
 */
function resolveGitDirs(root: string): { gitDir: string; commonDir: string } {
  const gitPath = join(root, '.git');
  const st = statSync(gitPath); // throws if absent ⇒ not a checkout
  if (st.isDirectory()) {
    return { gitDir: gitPath, commonDir: gitPath };
  }
  // `.git` is a file: `gitdir: <abs-or-relative-to-root path>`.
  const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitPath, 'utf8'));
  if (!m?.[1]) throw new Error('unrecognised .git file');
  const rawGitDir = m[1].trim();
  const gitDir = isAbsolute(rawGitDir) ? rawGitDir : resolve(root, rawGitDir);
  // The commondir (holding shared packed-refs) is named by `<gitDir>/commondir`,
  // a path relative to the gitdir; absent ⇒ the gitdir is itself the commondir.
  let commonDir = gitDir;
  const commonFile = join(gitDir, 'commondir');
  if (existsSync(commonFile)) {
    const cd = readFileSync(commonFile, 'utf8').trim();
    commonDir = isAbsolute(cd) ? cd : resolve(gitDir, cd);
  }
  return { gitDir, commonDir };
}

/** Look up `ref` (e.g. `refs/heads/main`) in the commondir's `packed-refs`; `''` if absent. */
function resolvePackedRef(commonDir: string, ref: string): string {
  const packed = join(commonDir, 'packed-refs');
  if (!existsSync(packed)) return '';
  for (const line of readFileSync(packed, 'utf8').split('\n')) {
    // Skip blanks, `# ...` header lines, and `^<peeled-tag>` annotation lines.
    if (!line || line.startsWith('#') || line.startsWith('^')) continue;
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    if (line.slice(sp + 1).trim() === ref) {
      const sha = line.slice(0, sp).trim();
      return SHA_RE.test(sha) ? sha : '';
    }
  }
  return '';
}

/**
 * Resolve a repo's current HEAD sha WITHOUT spawning git. `''` on ANY failure (not
 * a checkout, unreadable, unrecognised layout) — folds to not-fresh.
 *
 * `.git` may be a directory (checkout) or a file (`gitdir: …`, a linked worktree).
 * `HEAD` is read from the resolved gitdir; a `ref: <path>` is resolved against the
 * gitdir's then the commondir's loose ref file, then the commondir's `packed-refs`;
 * a detached HEAD is the raw sha in `HEAD` itself.
 */
export function resolveHeadSha(repoRoot: string): string {
  try {
    const root = repoRoot.replace(/\/+$/, '');
    const { gitDir, commonDir } = resolveGitDirs(root);
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref:')) {
      // Detached HEAD — the raw sha (validated; anything else is not resolvable).
      return SHA_RE.test(head) ? head : '';
    }
    const ref = head.slice(4).trim(); // e.g. refs/heads/main
    // Loose ref: the worktree's own gitdir first, then the shared commondir.
    for (const base of gitDir === commonDir ? [gitDir] : [gitDir, commonDir]) {
      const loose = join(base, ref);
      if (existsSync(loose)) {
        const sha = readFileSync(loose, 'utf8').trim();
        if (SHA_RE.test(sha)) return sha;
      }
    }
    // Packed-refs fallback (always in the commondir).
    return resolvePackedRef(commonDir, ref);
  } catch {
    return '';
  }
}

/** sha256 of `<repoRoot>/pnpm-lock.yaml`, or `''` when absent/unreadable. */
export function computeLockHash(repoRoot: string): string {
  try {
    const lock = join(repoRoot.replace(/\/+$/, ''), 'pnpm-lock.yaml');
    if (!existsSync(lock)) return '';
    return createHash('sha256').update(readFileSync(lock)).digest('hex');
  } catch {
    return '';
  }
}

/** The repo's current freshness identity (HEAD + lockfile), each folding safely to `''`. */
export function computeFreshness(repoRoot: string): PrepFreshness {
  return { headSha: resolveHeadSha(repoRoot), lockHash: computeLockHash(repoRoot) };
}

/**
 * Read + parse a repo's stamp. `null` when it is missing, unreadable, non-JSON, or
 * missing either string field (⇒ the caller treats it as a non-match ⇒ not fresh).
 */
export function readStamp(repoRoot: string): PrepFreshness | null {
  try {
    const parsed = JSON.parse(readFileSync(stampPath(repoRoot), 'utf8')) as Partial<PrepFreshness>;
    if (typeof parsed.headSha !== 'string' || typeof parsed.lockHash !== 'string') return null;
    return { headSha: parsed.headSha, lockHash: parsed.lockHash };
  } catch {
    return null;
  }
}

/**
 * True iff a stamp exists at the repo root AND its `{ headSha, lockHash }` equals
 * the repo's freshly-computed values. Missing / unparseable / any-field mismatch ⇒
 * false (⇒ not fresh ⇒ prep re-runs). An UNRESOLVABLE current HEAD (`headSha === ''`)
 * also ⇒ false, so a stored empty sha can never self-match (`'' === ''`) and leave the
 * HEAD dimension stale-blind — an exotic/corrupt `.git` layout forces a reprep instead.
 * Never throws — the safe #256 default.
 */
export function stampMatches(repoRoot: string): boolean {
  const stamp = readStamp(repoRoot);
  if (!stamp) return false;
  const cur = computeFreshness(repoRoot);
  // This fn is only consulted for real checkouts (isRepoBuilt short-circuits a
  // non-checkout on the `.git`-absent branch), so an empty current HEAD here means a
  // `.git` layout we could not read — fold to not-fresh rather than let '' self-match.
  if (cur.headSha === '') return false;
  return stamp.headSha === cur.headSha && stamp.lockHash === cur.lockHash;
}

/**
 * Write the freshness stamp for a repo the R1 pass just built+installed to
 * completion. Best-effort: a write failure is swallowed (a failed stamp costs at
 * most a needless reprep next run, never a crash mid-pass). `node_modules` is
 * guaranteed present here (install ran); its absence is still tolerated (skip).
 */
export function writeStamp(repoRoot: string): void {
  try {
    const path = stampPath(repoRoot);
    if (!existsSync(dirname(path))) return; // no node_modules ⇒ nothing installed
    writeFileSync(path, JSON.stringify(computeFreshness(repoRoot)));
  } catch {
    // best-effort — a failed stamp only costs a reprep, never correctness.
  }
}
