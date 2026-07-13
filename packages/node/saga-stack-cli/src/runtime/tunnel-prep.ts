/**
 * Native `--tunnel` prep IO (Phase 2, saga-ed/soa#214) — the two host-touching
 * steps up.sh's `--tunnel` resolution block does BEFORE any launch line runs, so
 * the per-service `tunnel_env` overlay has correct values:
 *
 *  1. `resolveTunnelMoniker` — run the VENDORED `tunnel.sh moniker` and capture
 *     its stdout (up.sh `TUNNEL_MONIKER=$("$SCRIPT_DIR/tunnel.sh" moniker)`). The
 *     moniker prompt (first run) talks on the TTY, so stdin+stderr are inherited
 *     while stdout is piped — exactly up.sh's `$()` capture with stderr on the TTY.
 *     `<moniker>.<VMS_BASE>` is the tunnel domain the overlay flips every browser
 *     URL to.
 *
 *  2. `generateTunnelFleetConfig` — render `rtsm-fleet-tunnel.json` from the base
 *     `rtsm-fleet-local.json`, swapping `nodes.local.endpoint` to the tunnel host
 *     so rtsm discovery returns a browser-reachable URL (up.sh's node -e block).
 *     Best-effort: on any failure rtsm-api keeps its local fleet (remote discovery
 *     falls back), never aborting the bring-up.
 *
 * Both live in `runtime/**` (OS-touching); the command wires them behind seams so
 * the unit tests inject fakes and never spawn tunnel.sh or read the fleet file.
 */

import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Best-effort fetch of the fleek dev-cluster LiveKit creds from Secrets Manager
 * (`qboard/fleek/livekit-creds`), mirroring up.sh's `--tunnel` AV block
 * (up.sh:2346-2351). Real cluster A/V needs connect-api to sign LiveKit tokens
 * with the CLUSTER key — absent creds ⇒ the caller leaves `LIVEKIT_API_KEY` at the
 * local dev default and the fleek cluster rejects the tokens (A/V fails; CRDT/chat
 * and everything else still work). The dev-account AWS profile is resolved the same
 * way tunnel.sh does (by account number) via `tunnel.sh aws-profile`. Returns null
 * on ANY failure (no creds / wrong account / aws missing / bad JSON) — never throws,
 * so it can't break the bring-up.
 */
export function resolveFleekLivekitCreds(
  vendorTunnelSh: string,
): { key: string; secret: string } | null {
  try {
    // The dev-account profile tunnel.sh resolves by account number (empty = default chain).
    let profile = '';
    try {
      profile = execFileSync(vendorTunnelSh, ['aws-profile'], {
        cwd: dirname(vendorTunnelSh),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      profile = '';
    }
    const raw = execFileSync(
      'aws',
      [
        'secretsmanager',
        'get-secret-value',
        '--secret-id',
        'qboard/fleek/livekit-creds',
        '--query',
        'SecretString',
        '--output',
        'text',
        '--region',
        'us-west-2',
        ...(profile ? ['--profile', profile] : []),
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    const parsed = JSON.parse(raw) as { api_key?: unknown; api_secret?: unknown };
    const key = typeof parsed.api_key === 'string' ? parsed.api_key : '';
    const secret = typeof parsed.api_secret === 'string' ? parsed.api_secret : '';
    return key && secret ? { key, secret } : null;
  } catch {
    return null;
  }
}

/**
 * Run `<vendorTunnelSh> moniker`, capturing trimmed stdout (the moniker). stdin +
 * stderr inherit the user's TTY so the first-run bootstrap prompt + any progress
 * still reach the terminal, matching up.sh's stderr-on-TTY `$()` capture. Rejects
 * on a non-zero exit / spawn error (the command turns it into a hard error, as
 * up.sh does — "could not resolve a moniker").
 */
export function resolveTunnelMoniker(vendorTunnelSh: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(vendorTunnelSh, ['moniker'], {
      cwd: dirname(vendorTunnelSh),
      stdio: ['inherit', 'pipe', 'inherit'],
    });
    let out = '';
    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      const moniker = out.trim();
      if (code === 0 && moniker) resolve(moniker);
      else reject(new Error(`tunnel.sh moniker failed (exit ${code ?? 'signal'})`));
    });
  });
}

/**
 * Render `rtsm-fleet-tunnel.json` from `localFleetPath`, swapping the single node's
 * `endpoint` to the browser-visible tunnel host (`rtsm.<tunnelDomain>`, bare — the
 * rtsm-client composes the scheme from its bootstrap URL). Returns the written path
 * on success, or `null` on any failure (best-effort; caller keeps the local fleet).
 */
export function generateTunnelFleetConfig(opts: {
  localFleetPath: string;
  outPath: string;
  tunnelDomain: string;
}): string | null {
  try {
    const cfg = JSON.parse(readFileSync(opts.localFleetPath, 'utf8')) as {
      nodes?: { local?: { endpoint?: string } };
      _comment?: string;
    };
    if (!cfg.nodes?.local) return null;
    cfg._comment =
      'GENERATED by saga-stack up --tunnel from rtsm-fleet-local.json — endpoint swapped to the tunnel host.';
    cfg.nodes.local.endpoint = `rtsm.${opts.tunnelDomain}`;
    writeFileSync(opts.outPath, `${JSON.stringify(cfg, null, 4)}\n`);
    return opts.outPath;
  } catch {
    return null;
  }
}

/**
 * Render a per-SLOT `rtsm-fleet-s<N>.json` from `localFleetPath`, swapping the single
 * node's browser-visible `endpoint` to the slot's own rtsm host (`localhost:<port>`,
 * bare — no scheme). Without this a slot>0 stack advertises the vendored `:6110`
 * endpoint and connect-web's browser CRDT socket split-brains onto slot 0's rtsm
 * (soa#271). Returns the written path, or `null` on any failure (best-effort — the
 * caller falls back to the vendored fleet, i.e. the pre-soa#271 behaviour).
 */
export function generateSlotFleetConfig(opts: {
  localFleetPath: string;
  outPath: string;
  endpoint: string;
}): string | null {
  try {
    const cfg = JSON.parse(readFileSync(opts.localFleetPath, 'utf8')) as {
      nodes?: { local?: { endpoint?: string } };
      _comment?: string;
    };
    if (!cfg.nodes?.local) return null;
    cfg._comment = `GENERATED by saga-stack up --slot from rtsm-fleet-local.json — endpoint swapped to the slot rtsm host (${opts.endpoint}).`;
    cfg.nodes.local.endpoint = opts.endpoint;
    writeFileSync(opts.outPath, `${JSON.stringify(cfg, null, 4)}\n`);
    return opts.outPath;
  } catch {
    return null;
  }
}
