/**
 * Fake-media planning (PURE) — turn a user's `--fake-video`/`--fake-audio` inputs into
 * (a) the ffmpeg transcode steps that produce Chromium-consumable capture files and
 * (b) the Chromium launch flags that feed them. No IO here: file existence, ffmpeg
 * execution, and caching live in `runtime/fake-media`.
 *
 * WHY: Chromium's fake device can play a FILE into `getUserMedia` via
 * `--use-file-for-fake-video-capture=<Y4M>` / `--use-file-for-fake-audio-capture=<WAV>`,
 * but ONLY those raw formats. So an `.mp4` the user hands us must be transcoded first:
 * video → Y4M (yuv420p), audio → 16-bit PCM WAV. A file ALREADY in the target format is
 * passed through untouched (a power user can pre-transcode and skip ffmpeg). When only a
 * video is given, its audio track is DERIVED from the same file (an mp4 usually carries
 * both) — a derive that fails (video-only source) is dropped, not fatal (see runtime).
 *
 * INVARIANT (plan hard constraint): this lives in `core/` and stays PURE — only
 * `node:path` string ops, no `fs`/spawn. The host IO lives in `runtime/fake-media`.
 */

import { basename, extname, join } from 'node:path';

/** The raw containers Chromium's file-backed fake capture requires. */
export const VIDEO_TARGET_EXT = '.y4m';
export const AUDIO_TARGET_EXT = '.wav';

/** One transcode (or passthrough) of a single capture stream. */
export interface FfmpegStep {
  /** Absolute source path (the user's file). */
  input: string;
  /** Absolute destination under the plan's `outDir` — or `=== input` when passthrough. */
  output: string;
  /** ffmpeg argv AFTER `ffmpeg` (empty when passthrough — nothing to run). */
  argv: string[];
  /** Input is ALREADY in the target format ⇒ no transcode, use as-is. */
  passthrough: boolean;
  /**
   * This AUDIO step's source is the VIDEO file (derived), not an explicit `--fake-audio`.
   * A derived transcode that fails (the video has no audio track) is NON-fatal — drop
   * audio, keep video; an EXPLICIT `--fake-audio` failure is fatal. Always false for video.
   */
  derived: boolean;
}

/** The transcodes to run for a `--fake-video`/`--fake-audio` request. */
export interface FakeMediaPlan {
  video?: FfmpegStep;
  audio?: FfmpegStep;
}

/** yuv420p Y4M — the widely-supported raw form Chromium's fake VIDEO capture reads. */
function videoArgv(input: string, output: string): string[] {
  return ['-y', '-i', input, '-pix_fmt', 'yuv420p', output];
}

/** 16-bit PCM WAV (mono, 48 kHz) — the form Chromium's fake AUDIO capture reads. `-vn` drops video. */
function audioArgv(input: string, output: string): string[] {
  return ['-y', '-i', input, '-vn', '-acodec', 'pcm_s16le', '-ar', '48000', '-ac', '1', output];
}

function makeStep(
  input: string,
  targetExt: string,
  outDir: string,
  kind: 'video' | 'audio',
  derived: boolean,
): FfmpegStep {
  if (extname(input).toLowerCase() === targetExt) {
    return { input, output: input, argv: [], passthrough: true, derived };
  }
  const output = join(outDir, `${basename(input, extname(input))}.fake-${kind}${targetExt}`);
  const argv = kind === 'video' ? videoArgv(input, output) : audioArgv(input, output);
  return { input, output, argv, passthrough: false, derived };
}

/**
 * Plan the transcodes. `video`/`audio` are ABSOLUTE paths (the command layer resolves
 * them). Audio source = `audio` if given, else the `video` file (DERIVED) — but never a
 * raw `.y4m` video, which carries no audio. Outputs land under `outDir`; a `.y4m`/`.wav`
 * input is passthrough. An empty request yields an empty plan.
 */
export function planFakeMedia(opts: { video?: string; audio?: string; outDir: string }): FakeMediaPlan {
  const plan: FakeMediaPlan = {};
  if (opts.video) plan.video = makeStep(opts.video, VIDEO_TARGET_EXT, opts.outDir, 'video', false);

  const explicitAudio = opts.audio;
  const derivedAudio =
    !explicitAudio && opts.video && extname(opts.video).toLowerCase() !== VIDEO_TARGET_EXT
      ? opts.video
      : undefined;
  const audioSrc = explicitAudio ?? derivedAudio;
  if (audioSrc) {
    plan.audio = makeStep(audioSrc, AUDIO_TARGET_EXT, opts.outDir, 'audio', explicitAudio === undefined);
  }
  return plan;
}

/**
 * The Chromium launch flags that feed the RESOLVED capture files into `getUserMedia`.
 * Any file present ⇒ enable the fake device + auto-accept the permission prompt, then a
 * per-stream file flag for whichever of video/audio resolved. No files ⇒ no flags.
 */
export function fakeMediaChromiumArgs(resolved: { video?: string; audio?: string }): string[] {
  if (!resolved.video && !resolved.audio) return [];
  const args = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];
  if (resolved.video) args.push(`--use-file-for-fake-video-capture=${resolved.video}`);
  if (resolved.audio) args.push(`--use-file-for-fake-audio-capture=${resolved.audio}`);
  return args;
}
