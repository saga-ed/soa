/**
 * `ss stack profile <service>` — capture a CPU profile from a RUNNING service.
 *
 * ATTACH MODE. The app is never a direct child of `pnpm dev` (backends nest it
 * inside tsup's quoted `--onSuccess` or a `tsx watch` fork), so nothing injected
 * at launch reaches it. This command leaves the launch path alone: find the
 * LISTENING process, open its inspector with SIGUSR1, pull the profile over CDP.
 * Port selection and its constraints: `core/inspector.ts`.
 */

import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { deriveInstance } from '../../core/derive-instance.js';
import { assertInspectorPortFree, INSPECTOR_PORT, profilableServices } from '../../core/inspector.js';
import { manifest } from '../../core/manifest/index.js';
import type { ServiceId } from '../../core/manifest/index.js';
import {
  defaultArtifactPath,
  parseDuration,
  planProfile,
  profileHasServiceFrames,
} from '../../core/profile-plan.js';
import { makeRealForeignIo, type ForeignIo } from '../../runtime/foreign-procs.js';
import { captureCpuProfile, inspectorPortBusy } from '../../runtime/profiler.js';

const DEFAULT_DURATION = '15s';

export default class StackProfile extends BaseCommand {
  static description =
    'Capture a CPU profile from a running service by attaching to it (SIGUSR1 + Chrome DevTools Protocol). ' +
    'Writes a .cpuprofile openable in Chrome DevTools or VS Code. Does not restart or modify the service.';

  static examples = [
    '<%= config.bin %> <%= command.id %> iam-api',
    '<%= config.bin %> <%= command.id %> sessions-api --duration 30s',
    '<%= config.bin %> <%= command.id %> coach-api --out /tmp/coach.cpuprofile',
    '<%= config.bin %> <%= command.id %> iam-api --slot 2 --output-json',
  ];

  static args = {
    service: Args.string({
      description: 'service to profile (a backend; frontends run a Vite dev server and are not profilable)',
      required: true,
      options: profilableServices(),
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    duration: Flags.string({
      description: `how long to sample for (e.g. 500ms, 30s, 2m); default ${DEFAULT_DURATION}`,
      default: DEFAULT_DURATION,
    }),
    out: Flags.string({
      description: 'artifact path; defaults to <state-dir>/<service>-<timestamp>.cpuprofile',
    }),
  };

  /** The slot picks WHICH service to profile; the inspector port is fixed (core/inspector.ts). */
  protected slotAware(): boolean {
    return true;
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parse(StackProfile);
    const service = args.service as ServiceId;
    const profile = deriveInstance({ slot: flags.slot });
    const stateDir = flags['state-dir'] ?? profile.stateDir;

    const durationMs = parseDuration(flags.duration);
    if (durationMs === null) {
      this.error(`--duration ${flags.duration} is not a duration (try 500ms, 30s, 2m)`);
    }

    // Fail loudly if a service has since been banded onto the inspector port —
    // otherwise the collision surfaces only as a profile of the wrong service.
    assertInspectorPortFree();

    const io: ForeignIo = makeRealForeignIo();
    const servicePort = profile.portOverrides[service] ?? manifest.services[service].port;
    const plan = await this.buildPlan(service, servicePort, stateDir, io);

    if (!plan.ok) {
      this.error(plan.reason);
    }

    if (!flags['output-json'] && !flags.porcelain) {
      this.log(`profiling ${service} (pid ${plan.pid}) for ${flags.duration} via inspector :${plan.port}`);
      if (!plan.adopted) {
        // Profilable, but not launched by this slot — say so rather than implying
        // ownership (the same provenance gap `down` warns about for foreign procs).
        this.log(`  note: pid ${plan.pid} was not launched by this slot — ${plan.command}`);
      }
    }

    const outPath = flags.out ?? defaultArtifactPath(stateDir, service, stamp());
    const result = await captureCpuProfile({
      pid: plan.pid,
      port: plan.port,
      durationMs,
      outPath,
      alreadyOpen: plan.alreadyOpen,
    });

    if (!result.ok) {
      this.error(`${service}: ${result.reason}`);
    }

    // Warn, don't fail: an idle service legitimately samples no app frames, and the
    // artifact is still valid. See `profileHasServiceFrames` for what the check means.
    const hasFrames = profileHasServiceFrames(result.profile, service);
    const samples = result.profile.samples?.length ?? 0;

    if (flags['output-json']) {
      this.logJson({ service, pid: plan.pid, port: plan.port, outPath, samples, hasServiceFrames: hasFrames });
      return;
    }
    if (flags.porcelain) {
      this.log([service, plan.pid, plan.port, samples, hasFrames ? 'app-frames' : 'no-app-frames', outPath].join('\t'));
      return;
    }
    this.log(`captured ${samples} samples → ${outPath}`);
    this.log(
      hasFrames
        ? '  contains frames from the service\'s own code.'
        : `  WARNING: no frames from ${service}'s own code — it may have been idle. Drive traffic while profiling.`,
    );
    this.log('  open in Chrome DevTools (Performance → Load profile) or VS Code.');
  }

  /** Gather the live facts the pure planner needs, then let it decide. */
  private async buildPlan(service: ServiceId, servicePort: number, stateDir: string, io: ForeignIo) {
    const listenerPid = await io.pidOnPort(servicePort);
    const proc = listenerPid === null ? null : await io.procInfo(listenerPid);
    const busy = await inspectorPortBusy(INSPECTOR_PORT);
    // Who holds the inspector port decides refuse-vs-reattach, so resolve it
    // rather than treating any held port as a conflict.
    const inspectorPortPid = busy ? await io.pidOnPort(INSPECTOR_PORT) : null;
    return planProfile(service, {
      listenerPid,
      proc,
      ownedPgids: io.ownedPgids(stateDir),
      inspectorPortBusy: busy,
      inspectorPortPid,
    });
  }
}

/** Filesystem-safe timestamp for the default artifact name. */
function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}
