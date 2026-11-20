/**
 * Fake-media planning (PURE) — soa#363. Cover the transcode plan (target formats,
 * passthrough, derived-audio rules, outDir) and the Chromium flag builder.
 */

import { describe, expect, it } from 'vitest';
import { fakeMediaChromiumArgs, planFakeMedia } from '../fake-media.js';

describe('planFakeMedia', () => {
  it('an .mp4 video plans a Y4M transcode AND derives a WAV audio from the same file', () => {
    const plan = planFakeMedia({ video: '/clips/student.mp4', outDir: '/state/fake-av' });
    expect(plan.video).toMatchObject({
      input: '/clips/student.mp4',
      output: '/state/fake-av/student.fake-video.y4m',
      passthrough: false,
      derived: false,
    });
    expect(plan.video?.argv).toEqual([
      '-nostdin', '-y', '-i', '/clips/student.mp4', '-pix_fmt', 'yuv420p', '/state/fake-av/student.fake-video.y4m',
    ]);
    // audio derived from the SAME file (mp4 carries both), marked derived ⇒ non-fatal.
    expect(plan.audio).toMatchObject({
      input: '/clips/student.mp4',
      output: '/state/fake-av/student.fake-audio.wav',
      passthrough: false,
      derived: true,
    });
    expect(plan.audio?.argv).toContain('-vn');
    expect(plan.audio?.argv).toContain('pcm_s16le');
    // -nostdin so a backgrounded transcode can't SIGTTIN-freeze on ffmpeg's stdin read.
    expect(plan.video?.argv[0]).toBe('-nostdin');
    expect(plan.audio?.argv[0]).toBe('-nostdin');
  });

  it('a .y4m video is passthrough (no transcode) and does NOT derive audio', () => {
    const plan = planFakeMedia({ video: '/clips/pattern.y4m', outDir: '/o' });
    expect(plan.video).toMatchObject({ output: '/clips/pattern.y4m', passthrough: true, argv: [] });
    expect(plan.audio).toBeUndefined(); // a raw .y4m has no audio to derive
  });

  it('an explicit --fake-audio is NOT derived (fatal on failure) and overrides derivation', () => {
    const plan = planFakeMedia({ video: '/v.mp4', audio: '/a.mp3', outDir: '/o' });
    expect(plan.audio).toMatchObject({ input: '/a.mp3', output: '/o/a.fake-audio.wav', derived: false });
  });

  it('a .wav audio is passthrough', () => {
    const plan = planFakeMedia({ audio: '/a.wav', outDir: '/o' });
    expect(plan.audio).toMatchObject({ output: '/a.wav', passthrough: true, argv: [] });
    expect(plan.video).toBeUndefined();
  });

  it('empty request ⇒ empty plan', () => {
    expect(planFakeMedia({ outDir: '/o' })).toEqual({});
  });
});

describe('fakeMediaChromiumArgs', () => {
  it('no files ⇒ no flags', () => {
    expect(fakeMediaChromiumArgs({})).toEqual([]);
  });

  it('video + audio ⇒ fake device + auto-accept + both file flags', () => {
    expect(fakeMediaChromiumArgs({ video: '/o/v.y4m', audio: '/o/a.wav' })).toEqual([
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--use-file-for-fake-video-capture=/o/v.y4m',
      '--use-file-for-fake-audio-capture=/o/a.wav',
    ]);
  });

  it('video only ⇒ no audio-capture flag', () => {
    const args = fakeMediaChromiumArgs({ video: '/o/v.y4m' });
    expect(args).toContain('--use-file-for-fake-video-capture=/o/v.y4m');
    expect(args.some((a) => a.startsWith('--use-file-for-fake-audio-capture'))).toBe(false);
  });
});
