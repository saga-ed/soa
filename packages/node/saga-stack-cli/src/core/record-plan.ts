/**
 * `--record [crdt|av]` fleek recording-stack model (Phase 2, saga-ed/soa#214) —
 * a PURE port of up.sh's `record_up()` (~619-666) as data.
 *
 * up.sh's `--record` opts in the fleek recording sidecars (recorder :7890 +
 * recordings-api :8444 + a MinIO S3 stand-in; `av` adds the LiveKit egress
 * sidecar for media capture) via fleek's own compose + LOCAL overlay. The
 * connect-api / connect-web recorder ENV is already wired UNCONDITIONALLY in the
 * service manifest (RECORDING_SERVICE_TOKEN / RECORDER_URL_TEMPLATE /
 * FLEEK_TOPOLOGY_JSON on connect-api; VITE_PLAYBACK_ASSET_BASE_OVERRIDE on
 * connect-web), so `--record`'s ONLY job is STARTING the fleek docker stack.
 *
 * This module computes the docker-compose invocation + env as pure data (no IO,
 * no docker, no AWS): the runtime `recordUp` seam layers the CodeArtifact build
 * token on top and shells it. The health targets are carried so the seam can
 * poll them.
 */

import type { RecordMode } from './flag-map.js';

/** Fleek recorder control port (up.sh `RECORDER_CONTROL_PORT`). */
export const RECORDER_CONTROL_PORT = 7890;
/** Fleek recordings-api port (up.sh `RECORDINGS_API_PORT`; 8443 is its prod port). */
export const RECORDINGS_API_PORT = 8444;

/** Host inputs the pure record-plan builder needs (all resolved by the runtime). */
export interface RecordPlanInputs {
  /** Absolute fleek checkout root (up.sh `$FLEEK`). */
  fleekRoot: string;
  /** Per-user recordings dir (up.sh `$FLEEK_REC_DIR`, `$HOME/.fleek-local/recordings`). */
  recordingsDir: string;
  /** Local single-node rtsm-api port (up.sh `$RTSM_PORT`). */
  rtsmPort: number;
  /** iam seed dev-user uuid (up.sh `$DEV_USER_UUID`). */
  devUserUuid: string;
  /** connect-web origin (up.sh `$CONNECT_WEB_URL`) — recordings-api allowed origin. */
  connectWebUrl: string;
  /** Legacy poll-content source (up.sh `$SAGA_API_TARGET`). */
  sagaApiTarget: string;
}

/** The fully-resolved record bring-up plan (pure data; runtime shells + polls it). */
export interface RecordPlan {
  mode: RecordMode;
  /** Compose services to build + start (`av` adds `egress`). */
  services: string[];
  /** Per-user recordings dir (the seam `mkdir -p`s this). */
  recordingsDir: string;
  /** The two `-f <file>` compose overlay paths (base + local). */
  composeFiles: [string, string];
  /** Full `docker compose …` argv (sans the binary) — `-f a -f b up -d --build --no-deps <svcs>`. */
  args: string[];
  /** Build/run env (up.sh's `env KEY=VAL … docker compose`), MINUS the runtime CodeArtifact token. */
  env: Record<string, string>;
  /** Health targets to poll after bring-up. */
  health: { name: string; url: string }[];
}

/**
 * Build the `--record <mode>` plan. `av` appends the LiveKit `egress` sidecar to
 * the `crdt` base set. Faithful to up.sh: `--no-deps` (qboard's livekit serves
 * :7880, not fleek's bundled one), `--build` (images build from source), and the
 * exact env fleek's local overlay reads.
 */
export function recordPlan(mode: RecordMode, inputs: RecordPlanInputs): RecordPlan {
  const baseCompose = `${inputs.fleekRoot}/docker-compose.yml`;
  const localCompose = `${inputs.fleekRoot}/docker-compose.local.yml`;
  const composeFiles: [string, string] = [baseCompose, localCompose];
  const services = ['recorder', 'recordings-api', 'minio', 'minio-init'];
  if (mode === 'av') services.push('egress');

  const args = [
    'compose',
    '-f',
    baseCompose,
    '-f',
    localCompose,
    'up',
    '-d',
    '--build',
    '--no-deps',
    ...services,
  ];

  const env: Record<string, string> = {
    FLEEK_LOCAL_RECORDINGS_DIR: inputs.recordingsDir,
    FLEEK_LOCAL_EGRESS_CONFIG: `${inputs.fleekRoot}/configs/egress-local.yaml`,
    RTSM_BOOTSTRAP_URL: `http://127.0.0.1:${inputs.rtsmPort}`,
    RECORDINGS_AUTH_ENABLED: 'false',
    RECORDINGS_DEV_USER_ID: inputs.devUserUuid,
    RECORDINGS_DEV_USER_ROLE: 'TUTOR',
    RECORDINGS_ALLOWED_ORIGINS: inputs.connectWebUrl,
    SAGA_API_TARGET: inputs.sagaApiTarget,
  };

  return {
    mode,
    services,
    recordingsDir: inputs.recordingsDir,
    composeFiles,
    args,
    env,
    health: [
      { name: 'fleek-recorder', url: `http://127.0.0.1:${RECORDER_CONTROL_PORT}/v1/health` },
      { name: 'fleek-recordings-api', url: `http://127.0.0.1:${RECORDINGS_API_PORT}/healthz` },
    ],
  };
}
