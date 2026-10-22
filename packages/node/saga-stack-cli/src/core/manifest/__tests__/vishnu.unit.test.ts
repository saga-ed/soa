import { describe, expect, it } from 'vitest';
import { closureOptsFor, closureOptsForIds, combineRequested } from '../../bundles.js';
import { computeClosure } from '../../closure.js';
import { deriveInstance } from '../../derive-instance.js';
import { defaultLaunchContext, resolveLaunchEnv, launchPlan } from '../../launch-plan.js';
import { manifest, type RepoKey, type ServiceId } from '../index.js';

const roots = Object.fromEntries(
  ['SOA', 'ROSTERING', 'PROGRAM_HUB', 'SAGA_DASH', 'COACH', 'SDS', 'QBOARD', 'RTSM', 'FLEEK']
    .map((key) => [key, `/workspace/${key}`]),
) as Record<RepoKey, string>;

describe('Vishnu synthetic-dev integration', () => {
  it('keeps the viewer opt-in without pulling or seeding applications just to observe them', () => {
    const all = Object.keys(manifest.services) as ServiceId[];
    expect(computeClosure(manifest, all).services).not.toContain('vishnu');
    const viewer = computeClosure(manifest, ['vishnu'], closureOptsFor(['vishnu']));
    expect(viewer.services).toEqual(['vishnu']);
    expect(viewer.databases).toEqual(['vishnu']);
    expect(new Set(viewer.mesh)).toEqual(new Set(['postgres', 'rabbitmq']));
    expect(closureOptsForIds(['vishnu']).withVishnu).toBe(true);
    expect(computeClosure(manifest, ['vishnu'], closureOptsFor(['playback'])).services).toEqual([]);
  });

  it('composes with dash and preserves the entire dashboard backend closure', () => {
    const fail = (message: string): never => { throw new Error(message); };
    const requested = combineRequested(undefined, ['dash', 'vishnu'], fail);
    const combined = computeClosure(manifest, requested, closureOptsFor(['dash', 'vishnu']));
    const dash = computeClosure(manifest, ['saga-dash']);
    expect(new Set(combined.services)).toEqual(new Set([...dash.services, 'vishnu']));
    expect(new Set(combined.mesh)).toEqual(new Set(dash.mesh));
    expect(new Set(combined.databases)).toEqual(new Set([...dash.databases, 'vishnu']));
  });

  it.each([0, 2])('binds the viewer to slot %s and its matching state directory', (slot) => {
    const profile = deriveInstance({ slot });
    const context = defaultLaunchContext({
      repoRoots: roots,
      vendorDir: '/vendor',
      portOverrides: profile.portOverrides,
      meshOffset: profile.meshOffset,
      stateDir: `/custom/state-${slot}`,
    });
    expect(launchPlan(manifest, ['vishnu'], 'stack', context)[0]!.healthUrl).toBe(`http://localhost:${8930 + slot * 1000}/api/health`);
    const env = resolveLaunchEnv('vishnu', 'stack', context);
    expect(env).toMatchObject({
      VISHNU_MODE: 'synthetic',
      VISHNU_SLOT: String(slot),
      VISHNU_SOA_ROOT: roots.SOA,
      VISHNU_STATE_DIR: `/custom/state-${slot}`,
    });
    expect(manifest.services.vishnu.adoptEnv).toEqual(expect.arrayContaining([
      'VISHNU_MODE', 'VISHNU_SLOT', 'VISHNU_STATE_DIR',
    ]));
    expect(manifest.services.vishnu.launch.cmd).toContain('--strictPort');
  });
});
