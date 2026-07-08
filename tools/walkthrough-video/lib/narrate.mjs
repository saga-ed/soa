/**
 * narrate.mjs — per-step TTS synthesis with content-hash caching.
 *
 * Reads a walkthrough's steps.mjs (STEPS array of {id, narration, ...}), synthesizes
 * one MP3 per step via a pluggable TTS engine, and writes:
 *   chunks/<id>.mp3       — the synthesized narration audio
 *   durations.json        — { [id]: durationSeconds } (via ffprobe)
 *   chunks-meta.json      — { [id]: { hash, model, voice } } — the cache key
 *
 * Engines (TTS_ENGINE env, default "openai"):
 *   openai — tts-1-hd/onyx by default. Needs OPENAI_API_KEY, or an AWS profile that can
 *            read the dev key from Secrets Manager (see README § Prerequisites).
 *   edge   — free, no API key, no AWS creds. Microsoft Edge's online TTS via the `edge-tts`
 *            npm package (unofficial, reverse-engineered). KNOWN BROKEN as of 2026-07: its
 *            hardcoded auth token returns 403 (Microsoft periodically rotates/blocks it —
 *            out of our control to fix). Kept as a pluggable option in case it starts
 *            working again or gets patched upstream; don't rely on it today. For a free/
 *            cheap iteration tier, use SKIP_NARRATE=1 instead (silent render) rather than
 *            this engine.
 *
 * Caching: a step is only re-synthesized if sha256(engine + model + voice + narration)
 * differs from what's recorded in chunks-meta.json for that id. Set FORCE=1 to bypass.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tts as edgeTts } from 'edge-tts/out/index.js';

const execFileAsync = promisify(execFile);

const TTS_ENGINE = process.env.TTS_ENGINE ?? 'openai';
const FORCE = process.env.FORCE === '1';

const ENGINE_DEFAULTS = {
  edge: { model: 'edge-tts', voice: process.env.TTS_VOICE ?? 'en-US-GuyNeural' },
  openai: { model: process.env.TTS_MODEL ?? 'tts-1-hd', voice: process.env.TTS_VOICE ?? 'onyx' },
};

if (!ENGINE_DEFAULTS[TTS_ENGINE]) {
  throw new Error(`Unknown TTS_ENGINE "${TTS_ENGINE}" — expected "edge" or "openai".`);
}

const { model: TTS_MODEL, voice: TTS_VOICE } = ENGINE_DEFAULTS[TTS_ENGINE];

// Dev OpenAI key lives in Secrets Manager, not a local .env — see README § Prerequisites.
// Note: Observer-tier profiles (saga, saga-dev) are denied GetSecretValue on this ARN —
// set WALKTHROUGH_AWS_PROFILE to a profile with access, or set OPENAI_API_KEY to bypass
// Secrets Manager entirely. Only consulted when TTS_ENGINE=openai.
const OPENAI_SECRET_ARN =
  'arn:aws:secretsmanager:us-west-2:531314149529:secret:openai-dev-apikey-W3MunH';
const AWS_PROFILE = process.env.WALKTHROUGH_AWS_PROFILE ?? 'saga-dev';

let cachedApiKey = null;

async function resolveApiKey() {
  if (cachedApiKey) return cachedApiKey;
  if (process.env.OPENAI_API_KEY) {
    cachedApiKey = process.env.OPENAI_API_KEY;
    return cachedApiKey;
  }

  const { stdout } = await execFileAsync('aws', [
    'secretsmanager', 'get-secret-value',
    '--secret-id', OPENAI_SECRET_ARN,
    '--profile', AWS_PROFILE,
    '--query', 'SecretString',
    '--output', 'text',
  ]).catch((err) => {
    throw new Error(
      `Failed to fetch OpenAI key from Secrets Manager (${OPENAI_SECRET_ARN}, profile ` +
        `${AWS_PROFILE}). Set OPENAI_API_KEY directly to bypass, or check AWS auth. ` +
        `Original error: ${err.message}`,
    );
  });

  const raw = stdout.trim();
  // The secret may be a bare string or a JSON blob like {"apiKey":"sk-..."}.
  try {
    const parsed = JSON.parse(raw);
    cachedApiKey = parsed.apiKey ?? parsed.OPENAI_API_KEY ?? parsed.key ?? raw;
  } catch {
    cachedApiKey = raw;
  }
  return cachedApiKey;
}

function hashFor(engine, model, voice, narration) {
  return createHash('sha256').update(`${engine}\n${model}\n${voice}\n${narration}`).digest('hex');
}

async function readJsonIfExists(filePath, fallback) {
  if (!existsSync(filePath)) return fallback;
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

async function probeDurationSeconds(filePath) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath,
  ]);
  return Number.parseFloat(stdout.trim());
}

async function synthesizeOpenai(narration) {
  const apiKey = await resolveApiKey();

  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: TTS_MODEL,
      voice: TTS_VOICE,
      input: narration,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenAI TTS request failed: ${res.status} ${res.statusText} — ${body}`);
  }

  return Buffer.from(await res.arrayBuffer());
}

async function synthesizeEdge(narration) {
  return Buffer.from(await edgeTts(narration, { voice: TTS_VOICE }));
}

async function synthesize(narration) {
  return TTS_ENGINE === 'edge' ? synthesizeEdge(narration) : synthesizeOpenai(narration);
}

/**
 * Synthesize narration audio for every step in `steps`, writing outputs under `outDir`.
 * Returns { durations: {[id]: seconds} } for record.mjs's slot-timing math.
 */
export async function narrateAll(steps, outDir) {
  const chunksDir = path.join(outDir, 'chunks');
  await mkdir(chunksDir, { recursive: true });

  const metaPath = path.join(outDir, 'chunks-meta.json');
  const durationsPath = path.join(outDir, 'durations.json');
  const prevMeta = await readJsonIfExists(metaPath, {});
  const prevDurations = await readJsonIfExists(durationsPath, {});

  const meta = {};
  const durations = {};

  for (const step of steps) {
    const hash = hashFor(TTS_ENGINE, TTS_MODEL, TTS_VOICE, step.narration);
    const mp3Path = path.join(chunksDir, `${step.id}.mp3`);
    const cacheHit =
      !FORCE &&
      prevMeta[step.id]?.hash === hash &&
      existsSync(mp3Path) &&
      typeof prevDurations[step.id] === 'number';

    if (cacheHit) {
      meta[step.id] = prevMeta[step.id];
      durations[step.id] = prevDurations[step.id];
      console.log(`  ${step.id}: cache hit`);
      continue;
    }

    console.log(`  ${step.id}: synthesizing (${TTS_ENGINE}/${TTS_MODEL}/${TTS_VOICE})…`);
    const audio = await synthesize(step.narration);
    await writeFile(mp3Path, audio);
    durations[step.id] = await probeDurationSeconds(mp3Path);
    meta[step.id] = { hash, engine: TTS_ENGINE, model: TTS_MODEL, voice: TTS_VOICE };
  }

  await writeFile(metaPath, JSON.stringify(meta, null, 2));
  await writeFile(durationsPath, JSON.stringify(durations, null, 2));

  return { durations };
}
