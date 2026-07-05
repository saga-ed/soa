/**
 * The `--record` fleek recording-stack bring-up seam (Phase 2, saga-ed/soa#214) —
 * the production IO behind the `RecordUp` seam the `up` facade calls. A faithful
 * port of up.sh's `record_up()` (~619-666): ensure qboard's redis + recreate its
 * livekit (recording webhook wiring), fetch a short-lived CodeArtifact build token,
 * then `docker compose … up -d --build --no-deps` the fleek recording sidecars and
 * health-poll the recorder + recordings-api.
 *
 * This file may touch the OS (spawn/exec, fs) — it lives in `runtime/**`, behind
 * the seam. The `up`-facade unit/int tests inject a FAKE `RecordUp`, so this is
 * never exercised without a real fleek checkout + docker + AWS.
 *
 * KNOWN BOUND (flagged): the CodeArtifact token fetch shells `aws` and the image
 * builds need Docker + network; there is no way to unit-test the real bring-up
 * without cloud. Everything up to the compose invocation is faithful to record_up.
 */

import { execFile, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import type { RecordPlan } from '../core/record-plan.js';
import type { RecordUp } from '../stack-api.js';

/** Run a command with stdio inherited; resolve the exit code (never throws). */
function runInherit(command: string, args: string[], cwd: string, env: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: 'inherit' });
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 0));
  });
}

/** Run a command capturing trimmed stdout; resolve '' on any error (never throws). */
function capture(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, args, { encoding: 'utf8' }, (err, stdout) => {
      resolve(err ? '' : (stdout ?? '').toString().trim());
    });
  });
}

/** Poll an HTTP URL for a 200, up to `tries` times at 1s spacing. */
async function pollHealthy(url: string, tries = 30): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.status === 200) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/**
 * The production `RecordUp`: bring the fleek recording stack up. Returns
 * `{ ok, message }` for the facade to fold into its `RecordResult` — a bring-up
 * failure is surfaced as `ok:false` with a diagnostic, never thrown, so a record
 * hiccup doesn't redden an otherwise-healthy stack.
 */
export function makeRealRecordUp(): RecordUp {
  return async (plan: RecordPlan, ctx: { qboardRoot: string }): Promise<{ ok: boolean; message: string }> => {
    try {
      mkdirSync(plan.recordingsDir, { recursive: true });
    } catch {
      /* best-effort */
    }

    // qboard redis first (livekit.yaml names it), then recreate livekit so it
    // serves the CURRENT webhook block (host.docker.internal:7889 → recorder).
    const redisCode = await runInherit('docker', ['compose', 'up', '-d', 'redis'], ctx.qboardRoot, {});
    if (redisCode !== 0) return { ok: false, message: '⚠ --record: qboard redis failed to start' };
    const lkCode = await runInherit(
      'docker',
      ['compose', 'up', '-d', '--force-recreate', 'livekit'],
      ctx.qboardRoot,
      {},
    );
    if (lkCode !== 0) return { ok: false, message: '⚠ --record: qboard livekit recreate failed' };

    // Short-lived CodeArtifact build token (12h TTL; build-time only, not persisted).
    const awsArgs = [
      'codeartifact',
      'get-authorization-token',
      '--domain',
      'saga',
      '--domain-owner',
      '531314149529',
      '--region',
      'us-west-2',
      ...(process.env.AWS_PROFILE ? ['--profile', process.env.AWS_PROFILE] : []),
      '--query',
      'authorizationToken',
      '--output',
      'text',
    ];
    const token = await capture('aws', awsArgs);
    if (!token || token === 'None') {
      return { ok: false, message: '⚠ --record: CodeArtifact token fetch failed (try: aws sso login)' };
    }

    // Build + start the recording sidecars (first build is slow).
    const code = await runInherit('docker', plan.args, ctx.qboardRoot, {
      ...plan.env,
      CODEARTIFACT_AUTH_TOKEN: token,
    });
    if (code !== 0) return { ok: false, message: `⚠ --record: recording stack failed (exit ${code})` };

    const health = await Promise.all(plan.health.map((h) => pollHealthy(h.url)));
    const allHealthy = health.every(Boolean);
    return {
      ok: allHealthy,
      message: allHealthy
        ? `✓ recording stack up (mode: ${plan.mode}) — ${plan.services.join(', ')}`
        : `⚠ recording stack started but a health check did not go green (mode: ${plan.mode})`,
    };
  };
}
