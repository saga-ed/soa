/**
 * AWS CLI seam for the `ss env` family (soa#355).
 *
 * Deliberately a SHELL-OUT to the `aws` binary, not an SDK dependency — the
 * CLI stays registry-dep-free (the gh_214 stance that keeps tunnel/overlay as
 * script wrappers), the user's `aws sso login` session and `--profile`
 * selection apply unchanged, and every call is visible in CloudTrail exactly
 * as if typed. Two verbs:
 *
 *   - `json(args)`  — one captured `aws … --output json` invocation, parsed.
 *   - `portForward` — the canonical SSM data-plane tunnel
 *     (`AWS-StartPortForwardingSessionToRemoteHost` via the shared jump host,
 *     the exact pattern iac's postgres-mirror workflow uses). Long-running
 *     child; resolves READY when the session-manager-plugin prints its
 *     "Waiting for connections" banner, rejects on early exit.
 *
 * INVARIANT: destructive/networked IO lives only in `src/runtime/**`; commands
 * reach this through `BaseCommand.getEnvAws()`. Tests fake the interface —
 * `makeRealEnvAws()` is the only spawn site.
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface EnvAwsResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface PortForwardRequest {
  /** SSM-managed instance id of the jump host (mi-… / i-…). */
  target: string;
  /** Remote endpoint the jump host forwards to (RDS/Mongo/db-host DNS). */
  host: string;
  remotePort: number;
  localPort: number;
  region: string;
  profile?: string;
}

export interface PortForwardHandle {
  pid: number | undefined;
  /** Resolves when the plugin reports it is listening; rejects on early exit/timeout. */
  ready: Promise<void>;
  /** Resolves with the exit code when the session ends (SIGTERM on stop()). */
  exited: Promise<number | null>;
  stop(): void;
}

/** One buffered `aws lambda invoke` (`env org reset --snapshot` — the db-host-v2 orchestrator). */
export interface LambdaInvokeRequest {
  functionName: string;
  /** JSON-serialized as the raw event payload. */
  payload: unknown;
  region: string;
  profile?: string;
}

export interface EnvAws {
  /** `aws <args> --output json`, captured and parsed. Throws (with stderr) on non-zero exit or unparseable output. */
  json(args: string[], opts?: { profile?: string; region?: string }): Promise<unknown>;
  /**
   * `aws lambda invoke` with a raw JSON payload; resolves the parsed response
   * BODY (the outfile), null when empty. Throws on non-zero exit, a
   * `FunctionError`, or an unparseable body — callers branch on the body's
   * own `ok` field per the orchestrator contract (exit code 0 is NOT success).
   */
  lambdaInvoke(req: LambdaInvokeRequest): Promise<unknown>;
  /** Open an SSM port-forwarding session through the jump host. */
  portForward(req: PortForwardRequest): PortForwardHandle;
}

/** Build the full argv for one `aws` call (exported for byte-level tests). */
export function awsArgs(args: string[], opts?: { profile?: string; region?: string }): string[] {
  const argv = [...args];
  if (opts?.profile !== undefined) argv.push('--profile', opts.profile);
  if (opts?.region !== undefined) argv.push('--region', opts.region);
  return argv;
}

/** Build the SSM start-session argv for a port-forward (exported for tests). */
export function portForwardArgs(req: PortForwardRequest): string[] {
  return awsArgs(
    [
      'ssm',
      'start-session',
      '--target',
      req.target,
      '--document-name',
      'AWS-StartPortForwardingSessionToRemoteHost',
      '--parameters',
      JSON.stringify({
        host: [req.host],
        portNumber: [String(req.remotePort)],
        localPortNumber: [String(req.localPort)],
      }),
    ],
    { profile: req.profile, region: req.region },
  );
}

/**
 * `aws lambda invoke` argv (exported for byte-level tests). The response body
 * lands in `outfile` (the CLI cannot cleanly stream it to stdout — metadata
 * shares the stream); `--cli-read-timeout 900` matches the Lambda's own 900s
 * cap so a slow pg_dump is not severed by the CLI's default 60s.
 */
export function lambdaInvokeArgs(req: LambdaInvokeRequest, outfile: string): string[] {
  return awsArgs(
    [
      'lambda',
      'invoke',
      '--function-name',
      req.functionName,
      '--cli-binary-format',
      'raw-in-base64-out',
      '--cli-read-timeout',
      '900',
      '--payload',
      JSON.stringify(req.payload),
      outfile,
    ],
    { profile: req.profile, region: req.region },
  );
}

const READY_MARKER = 'Waiting for connections';
const READY_TIMEOUT_MS = 30_000;

export function makeRealEnvAws(): EnvAws {
  return {
    async json(args, opts): Promise<unknown> {
      const argv = [...awsArgs(args, opts), '--output', 'json'];
      const result = await capture('aws', argv);
      if (result.code !== 0) {
        throw new Error(`aws ${args.slice(0, 3).join(' ')} exited ${result.code}: ${result.stderr.trim()}`);
      }
      // Some aws verbs legitimately print nothing (e.g. empty result sets).
      if (result.stdout.trim() === '') return null;
      try {
        return JSON.parse(result.stdout) as unknown;
      } catch {
        throw new Error(`aws ${args.slice(0, 3).join(' ')}: unparseable JSON output`);
      }
    },

    async lambdaInvoke(req): Promise<unknown> {
      const dir = mkdtempSync(join(tmpdir(), 'ss-env-lambda-'));
      const outfile = join(dir, 'response.json');
      try {
        const result = await capture('aws', [...lambdaInvokeArgs(req, outfile), '--output', 'json']);
        if (result.code !== 0) {
          throw new Error(`aws lambda invoke ${req.functionName} exited ${result.code}: ${result.stderr.trim()}`);
        }
        // stdout carries the invoke METADATA; a FunctionError there means the
        // body is an error blob, not the orchestrator response.
        try {
          const meta = JSON.parse(result.stdout) as { FunctionError?: string };
          if (meta.FunctionError !== undefined) {
            throw new Error(`lambda ${req.functionName} FunctionError: ${meta.FunctionError}`);
          }
        } catch (err) {
          if (err instanceof Error && err.message.includes('FunctionError')) throw err;
          // Unparseable metadata is tolerable — the body is the contract.
        }
        const body = readFileSync(outfile, 'utf8');
        if (body.trim() === '') return null;
        try {
          return JSON.parse(body) as unknown;
        } catch {
          throw new Error(`lambda ${req.functionName}: unparseable response body`);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },

    portForward(req): PortForwardHandle {
      const child: ChildProcess = spawn('aws', portForwardArgs(req), {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      const exited = new Promise<number | null>((resolve) => {
        child.on('exit', (code) => resolve(code));
      });
      const ready = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`port-forward to ${req.host}:${req.remotePort} not ready after ${READY_TIMEOUT_MS / 1000}s`));
        }, READY_TIMEOUT_MS);
        const scan = (chunk: Buffer): void => {
          output += chunk.toString();
          if (output.includes(READY_MARKER)) {
            clearTimeout(timer);
            resolve();
          }
        };
        child.stdout?.on('data', scan);
        child.stderr?.on('data', scan);
        void exited.then((code) => {
          clearTimeout(timer);
          reject(new Error(`port-forward exited early (${code}): ${output.trim().slice(-500)}`));
        });
      });
      // A never-awaited ready must not crash the process on early exit.
      ready.catch(() => undefined);
      return {
        pid: child.pid,
        ready,
        exited,
        stop: () => {
          child.kill('SIGTERM');
        },
      };
    },
  };
}

/**
 * The AWS account id the current credentials resolve to (`sts get-caller-identity`).
 * Used by the account preflight so a run pointed at the WRONG account fails with an
 * actionable message instead of a cryptic per-service error (a dev-account ledger
 * query in the prod account returns ResourceNotFoundException, ECS lookups return
 * empty, etc.). Returns undefined if the identity can't be read (treated as "skip
 * the guard" — a real AWS call downstream will surface the auth problem).
 */
export async function resolveCallerAccount(aws: EnvAws, opts: { profile?: string; region: string }): Promise<string | undefined> {
  try {
    const account = (await aws.json(['sts', 'get-caller-identity', '--query', 'Account'], opts)) as string | null;
    return account ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the SSM jump host: newest running instance carrying the Name tag that
 * is ALSO Online in SSM (the exact recipe iac's postgres-mirror workflow uses).
 * Returns undefined when none qualifies.
 */
export async function resolveJumpHost(
  aws: EnvAws,
  nameTag: string,
  opts: { profile?: string; region: string },
): Promise<string | undefined> {
  const ec2 = (await aws.json(
    [
      'ec2',
      'describe-instances',
      '--filters',
      `Name=tag:Name,Values=${nameTag}`,
      'Name=instance-state-name,Values=running',
      '--query',
      'Reservations[].Instances[].InstanceId',
    ],
    opts,
  )) as string[] | null;
  const candidates = ec2 ?? [];
  if (candidates.length === 0) return undefined;
  const online = (await aws.json(
    [
      'ssm',
      'describe-instance-information',
      '--filters',
      `Key=InstanceIds,Values=${candidates.join(',')}`,
      '--query',
      "InstanceInformationList[?PingStatus=='Online'].InstanceId",
    ],
    opts,
  )) as string[] | null;
  return (online ?? [])[0];
}

function capture(command: string, args: string[]): Promise<EnvAwsResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', reject); // ENOENT (aws not installed) surfaces directly
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}
