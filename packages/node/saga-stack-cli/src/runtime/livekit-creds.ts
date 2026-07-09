/**
 * LiveKit fleek-cluster creds fetch — the AWS Secrets Manager pull up.sh does
 * under `--tunnel` (`qboard/fleek/livekit-creds`), ported to the native `ss` path.
 *
 * WHY: tunnel mode points connect-api's AV at the REAL fleek dev LiveKit cluster
 * (local LiveKit is UDP/WebRTC — it can't ride the frp HTTP tunnels). connect-api
 * signs each room JOIN TOKEN with a LiveKit API key+secret; the cluster only
 * honours tokens signed with ITS real creds, not the local `devkey`. So without
 * these, a remote guest gets CRDT/chat (rtsm, websockets → tunnels fine) but AV
 * fails to connect. The launch-plan plumbing already forwards `tunnel.lkKey/
 * lkSecret` → `TUNNEL_LK_KEY/SECRET` → connect-api `LIVEKIT_API_KEY/SECRET`; this
 * module is the missing piece that RESOLVES them.
 *
 * BEST-EFFORT (up.sh parity): no aws CLI, no SSO session, no access to the
 * secret, or malformed JSON ⇒ `null`. The caller then leaves the creds unset and
 * connect-api falls back to the dev key (cluster AV fails LOUD) — never a silent
 * localhost fallback. Every shell-out folds errors into a safe answer; never
 * throws. The exec is behind the injectable `LivekitCredsIo` so tests assert the
 * aws-arg construction + JSON parsing with no real `aws`/`tunnel.sh` spawn.
 */

import { execFile } from 'node:child_process';
import { dirname } from 'node:path';

/** The fleek dev-cluster LiveKit API creds (from the `qboard/fleek/livekit-creds` secret). */
export interface LivekitCreds {
  apiKey: string;
  apiSecret: string;
}

/** Resolve the fleek-cluster LiveKit creds, or null when unavailable (best-effort). */
export type LivekitCredsFetch = (vendorTunnelSh: string) => Promise<LivekitCreds | null>;

/** The Secrets Manager secret id + region up.sh reads (keep in sync with up.sh). */
export const LIVEKIT_SECRET_ID = 'qboard/fleek/livekit-creds';
export const LIVEKIT_SECRET_REGION = 'us-west-2';

/** The injectable command runner: resolve trimmed stdout ('' on any error), NEVER throw. */
export interface LivekitCredsIo {
  run(command: string, args: string[], cwd?: string): Promise<string>;
}

/** The production `LivekitCredsIo` — `execFile`, folding every error into ''. */
export function makeRealLivekitCredsIo(): LivekitCredsIo {
  return {
    run(command: string, args: string[], cwd?: string): Promise<string> {
      return new Promise((resolve) => {
        execFile(command, args, { encoding: 'utf8', cwd, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
          resolve(err ? '' : (stdout ?? '').toString().trim());
        });
      });
    },
  };
}

/** Build the `aws secretsmanager get-secret-value` argv (profile omitted when empty). */
export function livekitSecretArgs(profile: string): string[] {
  return [
    'secretsmanager',
    'get-secret-value',
    '--secret-id',
    LIVEKIT_SECRET_ID,
    '--region',
    LIVEKIT_SECRET_REGION,
    ...(profile ? ['--profile', profile] : []),
    '--query',
    'SecretString',
    '--output',
    'text',
  ];
}

/** Parse a Secrets Manager `SecretString` into creds, or null (missing keys / bad JSON). */
export function parseLivekitSecret(raw: string): LivekitCreds | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { api_key?: string; api_secret?: string };
    if (parsed.api_key && parsed.api_secret) {
      return { apiKey: parsed.api_key, apiSecret: parsed.api_secret };
    }
  } catch {
    /* malformed SecretString ⇒ null */
  }
  return null;
}

/**
 * The production fetch: resolve the AWS profile from the vendored `tunnel.sh
 * aws-profile` (empty ⇒ the default credential chain, like up.sh's
 * `${TUNNEL_AWS_PROFILE:+--profile …}`), then `aws secretsmanager get-secret-value`
 * the JSON secret and pull its `api_key`/`api_secret`. Any miss ⇒ null.
 */
export function makeRealLivekitCredsFetch(io: LivekitCredsIo = makeRealLivekitCredsIo()): LivekitCredsFetch {
  return async (vendorTunnelSh: string): Promise<LivekitCreds | null> => {
    const profile = await io.run(vendorTunnelSh, ['aws-profile'], dirname(vendorTunnelSh));
    const raw = await io.run('aws', livekitSecretArgs(profile));
    return parseLivekitSecret(raw);
  };
}
