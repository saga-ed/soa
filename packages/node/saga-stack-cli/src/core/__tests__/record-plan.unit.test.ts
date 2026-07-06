/**
 * `recordPlan` unit tests (Phase 2, saga-ed/soa#214) — the PURE `--record [crdt|av]`
 * model. Asserts the fleek recording-stack docker-compose invocation + env (the
 * runtime seam layers the CodeArtifact token on top + shells it).
 */

import { describe, expect, it } from 'vitest';
import { RECORDER_CONTROL_PORT, RECORDINGS_API_PORT, recordPlan } from '../record-plan.js';

const INPUTS = {
  fleekRoot: '/w/fleek',
  recordingsDir: '/home/dev/.fleek-local/recordings',
  rtsmPort: 6110,
  devUserUuid: 'f0000004-0000-4000-8000-00000000beef',
  connectWebUrl: 'http://localhost:6210',
  sagaApiTarget: 'https://wootmath.com',
};

describe('recordPlan', () => {
  it('crdt: recorder + recordings-api + minio + minio-init (no egress)', () => {
    const p = recordPlan('crdt', INPUTS);
    expect(p.services).toEqual(['recorder', 'recordings-api', 'minio', 'minio-init']);
  });

  it('av: appends the LiveKit egress sidecar', () => {
    expect(recordPlan('av', INPUTS).services).toContain('egress');
  });

  it('compose argv: -f base -f local up -d --build --no-deps <services>', () => {
    const p = recordPlan('crdt', INPUTS);
    expect(p.args).toEqual([
      'compose',
      '-f',
      '/w/fleek/docker-compose.yml',
      '-f',
      '/w/fleek/docker-compose.local.yml',
      'up',
      '-d',
      '--build',
      '--no-deps',
      'recorder',
      'recordings-api',
      'minio',
      'minio-init',
    ]);
  });

  it('env: the fleek local-overlay knobs (recordings dir, rtsm bootstrap, dev identity, auth off)', () => {
    const p = recordPlan('crdt', INPUTS);
    expect(p.env).toEqual({
      FLEEK_LOCAL_RECORDINGS_DIR: '/home/dev/.fleek-local/recordings',
      FLEEK_LOCAL_EGRESS_CONFIG: '/w/fleek/configs/egress-local.yaml',
      RTSM_BOOTSTRAP_URL: 'http://127.0.0.1:6110',
      RECORDINGS_AUTH_ENABLED: 'false',
      RECORDINGS_DEV_USER_ID: 'f0000004-0000-4000-8000-00000000beef',
      RECORDINGS_DEV_USER_ROLE: 'TUTOR',
      RECORDINGS_ALLOWED_ORIGINS: 'http://localhost:6210',
      SAGA_API_TARGET: 'https://wootmath.com',
    });
  });

  it('health targets: recorder :7890/v1/health + recordings-api :8444/healthz', () => {
    const p = recordPlan('crdt', INPUTS);
    expect(p.health).toEqual([
      { name: 'fleek-recorder', url: `http://127.0.0.1:${RECORDER_CONTROL_PORT}/v1/health` },
      { name: 'fleek-recordings-api', url: `http://127.0.0.1:${RECORDINGS_API_PORT}/healthz` },
    ]);
    expect(RECORDER_CONTROL_PORT).toBe(7890);
    expect(RECORDINGS_API_PORT).toBe(8444);
  });
});
