/**
 * Fake-media IO (soa#363) — `prepareFakeMedia` over a FAKE Runner + fake stat, so no real
 * ffmpeg/fs runs. Covers: transcode both streams, passthrough (no ffmpeg), cache reuse,
 * derived-audio failure is non-fatal, explicit-audio failure throws, ffmpeg-missing
 * throws an install hint, and a missing input throws.
 */

import { describe, expect, it } from 'vitest';
import type { RunResult, Runner, ScriptInvocation } from '../exec.js';
import { prepareFakeMedia } from '../fake-media.js';

/** A Runner whose exit code per call is decided by `codeFor(spec)` (default 0). Records calls. */
function fakeRunner(codeFor: (s: ScriptInvocation) => number | 'throw' = () => 0): {
  runner: Runner;
  calls: ScriptInvocation[];
} {
  const calls: ScriptInvocation[] = [];
  const runner: Runner = {
    async run(spec): Promise<RunResult> {
      calls.push(spec);
      const c = codeFor(spec);
      if (c === 'throw') throw new Error('ENOENT: ffmpeg not found');
      return { code: c };
    },
  };
  return { runner, calls };
}

const NOOP = (): void => {};
// Inputs exist (mtime 100); transcode OUTPUTS (their basenames carry `.fake-`) don't yet
// exist (null) ⇒ every non-passthrough step actually transcodes rather than cache-hitting.
const inputsExist = (p: string): number | null => (p.includes('.fake-') ? null : 100);
const baseDeps = (runner: Runner, statMtime = inputsExist) => ({
  runner,
  statMtime,
  ensureDir: NOOP,
  notify: NOOP,
});

describe('prepareFakeMedia', () => {
  it('transcodes video + derived audio, gating ffmpeg presence first, and returns the outputs', async () => {
    const { runner, calls } = fakeRunner();
    const out = await prepareFakeMedia(
      { video: '/clips/s.mp4', outDir: '/state/fake-av' },
      baseDeps(runner),
    );
    expect(out).toEqual({
      video: '/state/fake-av/s.fake-video.y4m',
      audio: '/state/fake-av/s.fake-audio.wav',
    });
    // ffmpeg -version presence check, then the two transcodes.
    expect(calls.map((c) => c.args[0])).toEqual(['-version', '-y', '-y']);
    expect(calls[1].command).toBe('ffmpeg');
    expect(calls[1].args).toContain('/state/fake-av/s.fake-video.y4m');
  });

  it('passthrough inputs run NO ffmpeg (not even the -version presence check)', async () => {
    const { runner, calls } = fakeRunner();
    const out = await prepareFakeMedia(
      { video: '/clips/p.y4m', audio: '/clips/p.wav', outDir: '/o' },
      baseDeps(runner),
    );
    expect(out).toEqual({ video: '/clips/p.y4m', audio: '/clips/p.wav' });
    expect(calls).toEqual([]); // no transcode needed ⇒ ffmpeg never invoked
  });

  it('reuses a cached output that is at least as new as its input (no ffmpeg for that step)', async () => {
    // input mtime 100; the .y4m output mtime 200 (newer) ⇒ cache hit; audio output missing.
    const statMtime = (p: string): number | null => {
      if (p.endsWith('.mp4')) return 100;
      if (p.endsWith('.y4m')) return 200; // cached, newer than input
      return null; // audio .wav not yet produced
    };
    const { runner, calls } = fakeRunner();
    const out = await prepareFakeMedia(
      { video: '/c/s.mp4', outDir: '/o' },
      { runner, statMtime, ensureDir: NOOP, notify: NOOP },
    );
    expect(out.video).toBe('/o/s.fake-video.y4m');
    // -version + audio transcode only; the video step was a cache hit.
    const y4mTranscode = calls.find((c) => c.args.includes('/o/s.fake-video.y4m'));
    expect(y4mTranscode).toBeUndefined();
    expect(calls.some((c) => c.args.includes('/o/s.fake-audio.wav'))).toBe(true);
  });

  it('a DERIVED audio transcode failure is NON-fatal — video-only result, no throw', async () => {
    // ffmpeg -version ok; the .wav (derived audio) transcode fails (video had no audio).
    const { runner } = fakeRunner((s) => (s.args.some((a) => a.endsWith('.wav')) ? 1 : 0));
    const out = await prepareFakeMedia({ video: '/c/silent.mp4', outDir: '/o' }, baseDeps(runner));
    expect(out).toEqual({ video: '/o/silent.fake-video.y4m' }); // audio dropped, video kept
  });

  it('an EXPLICIT --fake-audio transcode failure THROWS', async () => {
    const { runner } = fakeRunner((s) => (s.args.some((a) => a.endsWith('.wav')) ? 1 : 0));
    await expect(
      prepareFakeMedia({ audio: '/c/bad.mp3', outDir: '/o' }, baseDeps(runner)),
    ).rejects.toThrow(/--fake-audio/);
  });

  it('ffmpeg missing (presence check rejects) throws an install hint when a transcode is needed', async () => {
    const { runner } = fakeRunner((s) => (s.args[0] === '-version' ? 'throw' : 0));
    await expect(
      prepareFakeMedia({ video: '/c/s.mp4', outDir: '/o' }, baseDeps(runner)),
    ).rejects.toThrow(/ffmpeg is required/);
  });

  it('a missing input file throws before any ffmpeg runs', async () => {
    const { runner, calls } = fakeRunner();
    await expect(
      prepareFakeMedia({ video: '/nope.mp4', outDir: '/o' }, { runner, statMtime: () => null, ensureDir: NOOP }),
    ).rejects.toThrow(/--fake-video file not found/);
    expect(calls).toEqual([]);
  });

  it('defaults ensureDir/notify (mkdir the outDir) — real deps path is exercised', async () => {
    const { runner } = fakeRunner();
    const spy = { made: '' };
    await prepareFakeMedia(
      { video: '/c/p.y4m', outDir: '/o' },
      { runner, statMtime: inputsExist, ensureDir: (d) => { spy.made = d; } },
    );
    expect(spy.made).toBe('/o');
  });
});
