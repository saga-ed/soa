/**
 * `env-aws` pure arg-builder units (soa#355) — the byte shape of every `aws`
 * shell-out the `ss env` family makes. These builders are the only part of the
 * seam testable without spawning; the real `capture`/`portForward`/`lambdaInvoke`
 * IO is exercised through the command int tests' fakes.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { awsArgs, lambdaInvokeArgs, makeRealEnvAws, portForwardArgs, probeLocalPort } from '../env-aws.js';

/** A port nothing is listening on: bind :0, read what the kernel gave us, release it. */
const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

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
        // Must be a port nothing holds, or the local-bind preflight below
        // rejects first and this stops exercising the DEADLINE path. A
        // hardcoded 15432 made that environment-dependent: a stray tunnel from
        // an earlier run is exactly what soa#370 is about.
        localPort: await freePort(),
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

/**
 * soa#370 — the port holder is the GRANDCHILD, so teardown must reach it.
 * `aws ssm start-session` only launches `session-manager-plugin`, and that is
 * what binds the local port. Killing the `aws` child alone leaves the plugin
 * reparented to init, still holding the port: confirmed live against dev, where
 * a COMPLETED concierge reset stranded a plugin on 127.0.0.1:15432 and broke
 * the very next run. The stub models that shape — a launcher whose background
 * child outlives it.
 */
describe('portForward — teardown reaps the grandchild, not just the launcher', () => {
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it('stop() kills the process the launcher spawned', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ss-env-aws-stub-'));
    const stub = join(dir, 'aws');
    const gcPidFile = join(dir, 'grandchild.pid');
    // Launcher shape: spawn a long-lived child, record it, then wait — exactly
    // how `aws` sits in front of session-manager-plugin.
    writeFileSync(stub, `#!/bin/sh\nsleep 60 &\necho $! > ${gcPidFile}\nwait\n`, { mode: 0o755 });
    const realPath = process.env.PATH;
    process.env.PATH = `${dir}:${realPath ?? ''}`;
    try {
      const handle = makeRealEnvAws().portForward({
        target: 'i-0abc',
        host: 'db.dbs-v2.local',
        remotePort: 5440,
        localPort: await freePort(),
        region: 'us-west-2',
        readyTimeoutMs: 5_000,
      });
      // Let the stub record its background child.
      let gcPid: number | undefined;
      for (let i = 0; i < 50 && gcPid === undefined; i++) {
        await new Promise((r) => setTimeout(r, 20));
        try {
          gcPid = Number(readFileSync(gcPidFile, 'utf8').trim());
        } catch {
          /* not written yet */
        }
      }
      expect(gcPid).toBeTypeOf('number');
      expect(alive(gcPid!)).toBe(true);
      handle.stop();
      await handle.exited;
      await new Promise((r) => setTimeout(r, 150));
      // The whole group must be gone — this is what frees the local port.
      expect(alive(gcPid!)).toBe(false);
    } finally {
      process.env.PATH = realPath;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});

/**
 * soa#370 — a local port held by an EARLIER process (one that predates the
 * reaping fix, a SIGKILLed run, a concurrent `ss env connect`, a stray local
 * postgres) must be named as the cause immediately. Reaping cannot free such a
 * port, and without the preflight the run burns the full readiness deadline and
 * then blames the SSM route — the misdiagnosis soa#370 was filed on.
 */
describe('portForward — a local port already in use is diagnosed, not blamed on the route', () => {
  const listenOn = (): Promise<{ server: Server; port: number }> =>
    new Promise((resolve) => {
      const server = createServer();
      server.listen(0, '127.0.0.1', () => {
        resolve({ server, port: (server.address() as { port: number }).port });
      });
    });

  it('probeLocalPort reports the errno for a bound port and undefined for a free one', async () => {
    const { server, port } = await listenOn();
    try {
      expect(await probeLocalPort(port)).toBe('EADDRINUSE');
    } finally {
      await new Promise((r) => server.close(r));
    }
    // Same port, now released.
    expect(await probeLocalPort(port)).toBeUndefined();
  });

  it('fails fast naming the port — not the document/target — and reaps the child', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ss-env-aws-stub-'));
    const stub = join(dir, 'aws');
    writeFileSync(stub, '#!/bin/sh\nsleep 60\n', { mode: 0o755 });
    const realPath = process.env.PATH;
    process.env.PATH = `${dir}:${realPath ?? ''}`;
    const { server, port } = await listenOn();
    try {
      const handle = makeRealEnvAws().portForward({
        target: 'i-0abc',
        host: 'coach-api-runtime.dbs-v2.local',
        remotePort: 5445,
        localPort: port,
        region: 'us-west-2',
        // Generous vs. the probe: if the deadline is what rejects, the
        // preflight did not do its job and this test must fail.
        readyTimeoutMs: 10_000,
      });
      await expect(handle.ready).rejects.toThrow(/already in use \(EADDRINUSE\)/);
      await expect(handle.ready).rejects.toThrow(/NOT a routing problem/);
      await expect(handle.ready).rejects.not.toThrow(/not ready after/);
      expect(await handle.exited).not.toBeUndefined();
    } finally {
      await new Promise((r) => server.close(r));
      process.env.PATH = realPath;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
