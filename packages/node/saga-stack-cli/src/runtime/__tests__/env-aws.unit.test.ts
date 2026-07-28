/**
 * `env-aws` pure arg-builder units (soa#355) — the byte shape of every `aws`
 * shell-out the `ss env` family makes. These builders are the only part of the
 * seam testable without spawning; the real `capture`/`portForward`/`lambdaInvoke`
 * IO is exercised through the command int tests' fakes.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { awsArgs, lambdaInvokeArgs, makeRealEnvAws, portForwardArgs } from '../env-aws.js';

describe('awsArgs — profile/region threading', () => {
  it('appends --profile and --region only when given', () => {
    expect(awsArgs(['sts', 'get-caller-identity'])).toEqual(['sts', 'get-caller-identity']);
    expect(awsArgs(['ssm', 'get-parameter'], { profile: 'dev_admin', region: 'us-west-2' })).toEqual([
      'ssm',
      'get-parameter',
      '--profile',
      'dev_admin',
      '--region',
      'us-west-2',
    ]);
    expect(awsArgs(['x'], { region: 'us-west-2' })).toEqual(['x', '--region', 'us-west-2']);
  });
});

describe('portForwardArgs — SSM start-session to a remote host', () => {
  it('builds the AWS-StartPortForwardingSessionToRemoteHost document with stringified ports', () => {
    const argv = portForwardArgs({
      target: 'i-0abc',
      host: 'db.dbs-v2.local',
      remotePort: 5440,
      localPort: 15432,
      region: 'us-west-2',
      profile: 'dev_admin',
    });
    expect(argv.slice(0, 6)).toEqual([
      'ssm',
      'start-session',
      '--target',
      'i-0abc',
      '--document-name',
      'AWS-StartPortForwardingSessionToRemoteHost',
    ]);
    const params = JSON.parse(argv[argv.indexOf('--parameters') + 1]!);
    expect(params).toEqual({ host: ['db.dbs-v2.local'], portNumber: ['5440'], localPortNumber: ['15432'] });
    expect(argv).toContain('--profile');
    expect(argv).toContain('dev_admin');
  });
});

describe('lambdaInvokeArgs — orchestrator invoke', () => {
  it('carries raw-in-base64-out, the 900s read timeout, the JSON payload, and the outfile last', () => {
    const argv = lambdaInvokeArgs(
      { functionName: 'dev-db-host-orchestrator', payload: { action: 'snapshot', serviceName: 'x', profile: 'pre-org-reset' }, region: 'us-west-2' },
      '/tmp/out.json',
    );
    expect(argv).toEqual([
      'lambda',
      'invoke',
      '--function-name',
      'dev-db-host-orchestrator',
      '--cli-binary-format',
      'raw-in-base64-out',
      '--cli-read-timeout',
      '900',
      '--payload',
      '{"action":"snapshot","serviceName":"x","profile":"pre-org-reset"}',
      '/tmp/out.json',
      '--region',
      'us-west-2',
    ]);
  });
});

/**
 * soa#370 — the readiness deadline must REAP the child, not abandon it.
 * `aws ssm start-session` keeps running (and the session-manager-plugin under
 * it keeps holding the local port) after we stop waiting, so an un-killed
 * child poisons that port for every later run: the next attempt times out too
 * and orphans another. That cascade is what made one transient failure look
 * like a permanently broken tunnel. Uses a stub `aws` on PATH that never
 * prints the readiness banner.
 */
describe('portForward — a timed-out session is killed, never orphaned', () => {
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it('SIGTERMs the child when the readiness deadline passes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ss-env-aws-stub-'));
    const stub = join(dir, 'aws');
    // Silent and long-lived: exactly the shape that stranded a real session.
    writeFileSync(stub, '#!/bin/sh\nsleep 60\n', { mode: 0o755 });
    const realPath = process.env.PATH;
    process.env.PATH = `${dir}:${realPath ?? ''}`;
    try {
      const handle = makeRealEnvAws().portForward({
        target: 'i-0abc',
        host: 'db.dbs-v2.local',
        remotePort: 5440,
        localPort: 15432,
        region: 'us-west-2',
        readyTimeoutMs: 250,
      });
      const pid = handle.pid;
      expect(pid).toBeTypeOf('number');
      await expect(handle.ready).rejects.toThrow(/not ready after/);
      // The message must point at the port-holding culprit, not just the port.
      await expect(handle.ready).rejects.toThrow(/session-manager-plugin/);
      await handle.exited;
      expect(alive(pid!)).toBe(false);
    } finally {
      process.env.PATH = realPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
