/**
 * Manifest CONSISTENCY guard (plan §2.2, saga-ed/soa#214).
 *
 * The manifest's correctness rests on well-formed edges: every `ServiceDef.repo`
 * must be a real `RepoKey`, every `databases[]` entry a real `DbId`, every
 * `dependsOn` a real `ServiceId`, and every seed-registry step must name a real
 * service. TypeScript's closed unions catch most of this at compile time, but the
 * hand-maintained parallel structures (`REPO_DEFAULT_DIR`, the zod `SERVICE_IDS`
 * enum) can drift silently — this test pins them all against the frozen manifest
 * so adding a service/db (e.g. the coach pair) can't leave a stale edge behind.
 */

import { describe, expect, it } from 'vitest';
import { serviceIdSchema } from '../../flow/types.js';
import { buildSeedRegistry } from '../../seed/profiles.js';
import { REPO_DEFAULT_DIR } from '../../../runtime/scripts.js';
import { manifest } from '../index.js';
import type { DbId, RepoKey, ServiceId } from '../index.js';

const SERVICE_IDS = new Set(Object.keys(manifest.services) as ServiceId[]);
const DB_IDS = new Set(Object.keys(manifest.databases) as DbId[]);
const REPO_KEYS = new Set(Object.keys(REPO_DEFAULT_DIR) as RepoKey[]);

describe('manifest consistency — every edge resolves', () => {
  it('every ServiceDef.repo is a known RepoKey (has a checkout-dir default)', () => {
    for (const svc of Object.values(manifest.services)) {
      expect(REPO_KEYS.has(svc.repo)).toBe(true);
    }
  });

  it("every service's databases[] entries are known DbIds", () => {
    for (const svc of Object.values(manifest.services)) {
      for (const db of svc.databases) expect(DB_IDS.has(db)).toBe(true);
    }
  });

  it('every dependsOn / depKinds edge resolves to a known ServiceId', () => {
    for (const svc of Object.values(manifest.services)) {
      for (const dep of svc.dependsOn) expect(SERVICE_IDS.has(dep)).toBe(true);
      for (const dep of Object.keys(svc.depKinds)) expect(SERVICE_IDS.has(dep as ServiceId)).toBe(true);
    }
  });

  it('every seed-registry step names a known ServiceId', () => {
    const registry = buildSeedRegistry(manifest);
    for (const step of Object.values(registry)) {
      expect(SERVICE_IDS.has(step.service)).toBe(true);
      for (const db of step.databases) expect(DB_IDS.has(db)).toBe(true);
      for (const sub of step.optionalSteps ?? []) {
        expect(SERVICE_IDS.has(sub.service)).toBe(true);
      }
    }
  });

  it('the flow zod ServiceId enum is EXHAUSTIVE (accepts every manifest ServiceId)', () => {
    // Guards the drift class where a new service (e.g. coach-*) is added to the
    // union but not to the hand-maintained z.enum list.
    for (const id of SERVICE_IDS) {
      expect(serviceIdSchema.safeParse(id).success).toBe(true);
    }
  });

  it('includes the coach pair, wired to the COACH repo + coach_api DB', () => {
    expect(manifest.services['coach-api'].repo).toBe('COACH');
    expect(manifest.services['coach-api'].databases).toEqual(['coach_api']);
    expect(manifest.services['coach-web'].repo).toBe('COACH');
    expect(manifest.services['coach-web'].dependsOn).toEqual(['coach-api']);
    expect(manifest.databases['coach_api'].ownerRole).toBe('coach_api_app');
  });

  // M9 (apply_fixes parity, up.sh ~457-467): iam-api's launch env lifts the login
  // rate-limit + access-token TTL far above prod caps for long local dev/e2e sessions.
  it("iam-api launch.env carries the apply_fixes rate-limit + JWT-TTL knobs", () => {
    const env = manifest.services['iam-api'].launch.env;
    expect(env.SECURITY_RATELIMITMAXREQUESTS).toBe('1000000');
    expect(env.JWT_ACCESSTOKENTTLSECONDS).toBe('28800');
  });
});
