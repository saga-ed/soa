/**
 * Fake-media IO (soa#363) — execute the pure `planFakeMedia` transcodes via ffmpeg and
 * return the resolved Chromium capture paths. The ONLY place ffmpeg runs + the fs is
 * touched for the fake-AV feature; `core/fake-media` stays pure.
 *
 * Behaviours:
 *  - PRESENCE: if any step needs a transcode, `ffmpeg -version` must succeed, else a
 *    clear install hint is thrown. A passthrough-only plan (`.y4m`/`.wav` inputs) needs
 *    no ffmpeg and skips the check.
 *  - CACHE: an output at least as new as its input is reused — Y4M is large and slow to
 *    produce, so a repeated `login` with the same clip doesn't re-transcode.
 *  - DERIVED audio is best-effort: a failed derive (a video with no audio track) drops
 *    audio and keeps video; an EXPLICIT `--fake-audio` failure throws.
 *  - BACKGROUND-SAFE: every ffmpeg run routes stdin from /dev/null (`stdinFile`), so a
 *    backgrounded `ss stack login --fake-video` can't take SIGTTIN on ffmpeg's stdin read
 *    and STOP (`-nostdin` in the argv is the matching belt-and-suspenders). Without this
 *    the transcode freezes and the browser never launches.
 *
 * IO is behind injectable deps (Runner + stat/mkdir seams) so it is unit-tested with a
 * fake runner and NO real ffmpeg/fs.
 */

import { mkdirSync, statSync } from 'node:fs';
import { planFakeMedia } from '../core/fake-media.js';
import type { FfmpegStep } from '../core/fake-media.js';
import type { Runner } from './exec.js';

/** Injectable deps of {@link prepareFakeMedia}, defaulted to real IO. */
export interface PrepareFakeMediaDeps {
  /** Runs ffmpeg. A spawn-level failure (ffmpeg missing) REJECTS — caught as "not found". */
  runner: Runner;
  /** mtimeMs of a path, or `null` if it doesn't exist. Default `fs.statSync`. */
  statMtime?: (path: string) => number | null;
  /** `mkdir -p` the transcode outDir. Default `fs.mkdirSync({recursive})`. */
  ensureDir?: (dir: string) => void;
  /** Progress-line sink (transcode notices). Default no-op. */
  notify?: (msg: string) => void;
}

/** The resolved Chromium capture paths (a stream is absent when it had no source / was dropped). */
export interface PreparedFakeMedia {
  video?: string;
  audio?: string;
}

const realStatMtime = (p: string): number | null => {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return null;
  }
};

/**
 * `/dev/null` stdin for every ffmpeg run: a backgrounded transcode must never read the
 * controlling terminal (SIGTTIN → STOP → frozen transcode → no browser). See module header.
 */
const NULL_STDIN = '/dev/null';

/** Run `ffmpeg -version` once to confirm it is on PATH; throw an install hint if not. */
async function assertFfmpeg(runner: Runner): Promise<void> {
  try {
    const { code } = await runner.run({
      cwd: process.cwd(),
      command: 'ffmpeg',
      args: ['-version'],
      env: {},
      stdinFile: NULL_STDIN,
    });
    if (code === 0) return;
  } catch {
    // spawn-level failure (ENOENT) — fall through to the throw.
  }
  throw new Error(
    'ffmpeg is required to transcode --fake-video/--fake-audio to Chromium capture format, but was ' +
      'not found on PATH. Install it (macOS: `brew install ffmpeg`; Debian/Ubuntu: `sudo apt install ' +
      'ffmpeg`), or pass an already-transcoded .y4m video / .wav audio file.',
  );
}

/** Run one transcode step (or a no-op passthrough / cache hit). Never throws — returns the outcome. */
async function runStep(
  step: FfmpegStep,
  runner: Runner,
  statMtime: (p: string) => number | null,
  notify: (msg: string) => void,
): Promise<'ok' | 'failed'> {
  if (step.passthrough) return 'ok';
  const inM = statMtime(step.input);
  const outM = statMtime(step.output);
  if (outM !== null && inM !== null && outM >= inM) {
    notify(`  · reusing transcoded ${step.output} (cache)`);
    return 'ok';
  }
  notify(`  · ffmpeg ${step.input} → ${step.output}`);
  try {
    const { code } = await runner.run({
      cwd: process.cwd(),
      command: 'ffmpeg',
      args: step.argv,
      env: {},
      // stdout/stderr inherit (progress visible); stdin from /dev/null so a backgrounded
      // run can't SIGTTIN-freeze on ffmpeg's interactive stdin read (soa#363).
      stdinFile: NULL_STDIN,
    });
    return code === 0 ? 'ok' : 'failed';
  } catch {
    return 'failed';
  }
}

/**
 * Transcode the `--fake-video`/`--fake-audio` inputs (absolute paths) into Chromium
 * capture files under `outDir`, returning the resolved paths. Validates the explicit
 * inputs exist, gates ffmpeg presence when a real transcode is needed, reuses a cached
 * output, and tolerates a failed DERIVED audio derive (video-only source). Throws with a
 * clear message on a missing input, missing ffmpeg, or a fatal transcode failure.
 */
export async function prepareFakeMedia(
  opts: { video?: string; audio?: string; outDir: string },
  deps: PrepareFakeMediaDeps,
): Promise<PreparedFakeMedia> {
  const statMtime = deps.statMtime ?? realStatMtime;
  const ensureDir = deps.ensureDir ?? ((d: string): void => void mkdirSync(d, { recursive: true }));
  const notify = deps.notify ?? ((): void => {});

  if (opts.video && statMtime(opts.video) === null) {
    throw new Error(`--fake-video file not found: ${opts.video}`);
  }
  if (opts.audio && statMtime(opts.audio) === null) {
    throw new Error(`--fake-audio file not found: ${opts.audio}`);
  }

  const plan = planFakeMedia(opts);
  const needsTranscode = [plan.video, plan.audio].some((s) => s && !s.passthrough);
  if (needsTranscode) await assertFfmpeg(deps.runner);
  ensureDir(opts.outDir);

  const out: PreparedFakeMedia = {};
  if (plan.video) {
    if ((await runStep(plan.video, deps.runner, statMtime, notify)) === 'ok') {
      out.video = plan.video.output;
    } else {
      throw new Error(`ffmpeg failed to transcode --fake-video (${plan.video.input}) — see the output above`);
    }
  }
  if (plan.audio) {
    const res = await runStep(plan.audio, deps.runner, statMtime, notify);
    if (res === 'ok') {
      out.audio = plan.audio.output;
    } else if (plan.audio.derived) {
      notify(`  ⚠ no audio track derived from ${plan.audio.input} — continuing with video only`);
    } else {
      throw new Error(`ffmpeg failed to transcode --fake-audio (${plan.audio.input}) — see the output above`);
    }
  }
  return out;
}
