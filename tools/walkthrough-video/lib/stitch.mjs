/**
 * stitch.mjs — pad each narration chunk to its recorded slot, concat into one audio
 * track, mux it onto the recorded video, and emit an SRT built from slot timestamps.
 *
 * Inputs (all under a walkthrough's outDir, produced by narrate.mjs + record.mjs):
 *   chunks/<id>.mp3      — per-step narration audio
 *   slots.json           — { [id]: { audio, action, slot } } (seconds), in step order
 *   video/walkthrough.webm
 *
 * Outputs:
 *   video/walkthrough.mp4          — H.264 + AAC + mov_text soft-subtitle track, muxed
 *   video/walkthrough-vp9.webm     — VP9 + Opus sidecar (avoids the GStreamer/Totem
 *                                    H.264 playback trap on some Linux desktops; webm
 *                                    doesn't support mov_text, so this one carries no
 *                                    subtitle track — use the .srt sidecar with it)
 *   video/walkthrough.srt          — subtitles from cumulative slot timestamps, also
 *                                    muxed into walkthrough.mp4 as a selectable track
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function srtTimestamp(totalSeconds) {
  const ms = Math.round(totalSeconds * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const millis = ms % 1000;
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(millis, 3)}`;
}

function buildSrt(steps, slots) {
  let cursor = 0;
  const blocks = [];
  steps.forEach((step, i) => {
    const slot = slots[step.id]?.slot ?? 0;
    const start = cursor;
    const end = cursor + slot;
    blocks.push(
      `${i + 1}\n${srtTimestamp(start)} --> ${srtTimestamp(end)}\n${step.narration}\n`,
    );
    cursor = end;
  });
  return blocks.join('\n');
}

/**
 * Generate `targetSeconds` of silence at `outPath` — used when a step has no narration
 * chunk (SKIP_NARRATE=1 runs), so the audio track still spans the full recorded video.
 */
async function silenceOfLength(targetSeconds, outPath) {
  await execFileAsync('ffmpeg', [
    '-y',
    '-f', 'lavfi',
    '-i', 'anullsrc=r=48000:cl=stereo',
    '-t', `${Math.max(targetSeconds, 0.1)}`,
    outPath,
  ]);
}

/**
 * Pad `mp3Path` with trailing silence to reach `targetSeconds`, writing `outPath`.
 */
async function padToSlot(mp3Path, targetSeconds, outPath) {
  if (!existsSync(mp3Path)) {
    await silenceOfLength(targetSeconds, outPath);
    return;
  }
  await execFileAsync('ffmpeg', [
    '-y',
    '-i', mp3Path,
    '-af', `apad=whole_dur=${targetSeconds}`,
    '-ar', '48000',
    '-ac', '2',
    outPath,
  ]);
}

async function concatAudio(paddedPaths, listPath, outPath) {
  const listContents = paddedPaths.map((p) => `file '${path.resolve(p)}'`).join('\n');
  await writeFile(listPath, listContents);
  await execFileAsync('ffmpeg', [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', listPath,
    '-c', 'copy',
    outPath,
  ]);
}

async function muxMp4(videoPath, audioPath, srtPath, outPath) {
  await execFileAsync('ffmpeg', [
    '-y',
    '-i', videoPath,
    '-i', audioPath,
    '-i', srtPath,
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-c:s', 'mov_text',
    '-metadata:s:s:0', 'language=eng',
    '-shortest',
    outPath,
  ]);
}

async function muxVp9Sidecar(webmPath, audioPath, outPath) {
  await execFileAsync('ffmpeg', [
    '-y',
    '-i', webmPath,
    '-i', audioPath,
    '-c:v', 'libvpx-vp9',
    '-crf', '32',
    '-b:v', '0',
    '-deadline', 'good',
    '-cpu-used', '4',
    '-pix_fmt', 'yuv420p',
    '-r', '25',
    '-c:a', 'libopus',
    '-b:a', '96k',
    '-ar', '48000',
    '-ac', '2',
    '-shortest',
    '-f', 'webm',
    outPath,
  ]);
}

/**
 * Run the full stitch stage for one walkthrough. `steps` is the STEPS array (order
 * matters — it's the SRT/audio-concat order); `outDir` holds chunks/slots/video per
 * the layout above.
 */
export async function stitch(steps, outDir) {
  const videoDir = path.join(outDir, 'video');
  await mkdir(videoDir, { recursive: true });

  const slots = JSON.parse(await readFile(path.join(outDir, 'slots.json'), 'utf8'));

  const paddedDir = path.join(outDir, 'chunks-padded');
  await mkdir(paddedDir, { recursive: true });

  const paddedPaths = [];
  for (const step of steps) {
    const mp3Path = path.join(outDir, 'chunks', `${step.id}.mp3`);
    const slotSeconds = slots[step.id]?.slot ?? 0;
    const paddedPath = path.join(paddedDir, `${step.id}.mp3`);
    await padToSlot(mp3Path, slotSeconds, paddedPath);
    paddedPaths.push(paddedPath);
  }

  const concatListPath = path.join(paddedDir, 'concat-list.txt');
  const fullAudioPath = path.join(outDir, 'video', 'walkthrough.audio.mp3');
  await concatAudio(paddedPaths, concatListPath, fullAudioPath);

  const srtPath = path.join(videoDir, 'walkthrough.srt');
  await writeFile(srtPath, buildSrt(steps, slots));

  const webmPath = path.join(videoDir, 'walkthrough.webm');
  const mp4Path = path.join(videoDir, 'walkthrough.mp4');
  const vp9Path = path.join(videoDir, 'walkthrough-vp9.webm');
  await muxMp4(webmPath, fullAudioPath, srtPath, mp4Path);
  await muxVp9Sidecar(webmPath, fullAudioPath, vp9Path);

  return { mp4Path, vp9Path, srtPath };
}
