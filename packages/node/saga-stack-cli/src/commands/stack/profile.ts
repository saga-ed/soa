/**
 * `ss stack profile <service>` — capture a CPU profile from a RUNNING service.
 *
 * ATTACH MODE, and why it has to be. The app process is never a direct child of
 * `pnpm dev`: 14 backends nest it inside tsup's quoted `--onSuccess` string and 2
 * inside a `tsx watch` supervisor fork, so the real `node dist/main.js` sits 4
 * levels below the pid `ss` records. Nothing injected at launch reaches it —
 * `--inspect` as argv is rejected outright by tsup's cac, and via NODE_OPTIONS the
 * pnpm wrapper binds the port first. So this command touches the launch path not at
 * all: it finds the process that is actually LISTENING, opens its inspector with
 * SIGUSR1, and pulls the profile over CDP while the process runs.
 *
 * `stack up` presets each backend's inspector PORT (`--inspect-port`, which leaves
 * the inspector closed) so the attach is unambiguous and slot-isolated — see
 * `core/inspector.ts`.
 */

import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { deriveInstance } from '../../core/derive-instance.js';
import { inspectorPort } from '../../core/inspector.js';
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
      options: (Object.keys(manifest.services) as ServiceId[]).filter(
        (id) => !manifest.services[id].isFrontend,
      ),
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

  /** Profiling targets ONE slot's service — the slot picks the inspector port. */
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

    const io: ForeignIo = makeRealForeignIo();
    const servicePort = profile.portOverrides[service] ?? manifest.services[service].port;
    const plan = await this.buildPlan(service, profile.slot, servicePort, stateDir, io);

    if (!plan.ok) {
      this.error(plan.reason);
      return;
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
    });

    if (!result.ok) {
      this.error(`${service}: ${result.reason}`);
      return;
    }

    // A profile of pnpm/tsup has plenty of nodes but none from the service's own
    // dist — exactly how the earlier --cpu-prof attempt looked fine while being
    // useless. Warn rather than fail: a genuinely idle service can sample no app
    // frames, and the artifact is still valid.
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
        : `  WARNING: no frames from ${service}'s own dist — it may have been idle. Drive traffic while profiling.`,
    );
    this.log('  open in Chrome DevTools (Performance → Load profile) or VS Code.');
  }

  /** Gather the live facts the pure planner needs, then let it decide. */
  private async buildPlan(
    service: ServiceId,
    slot: number,
    servicePort: number,
    stateDir: string,
    io: ForeignIo,
  ) {
    const listenerPid = await io.pidOnPort(servicePort);
    const proc = listenerPid === null ? null : await io.procInfo(listenerPid);
    const port = inspectorPort(service, slot);
    const busy = port === null ? false : await inspectorPortBusy(port);
    return planProfile(service, slot, {
      listenerPid,
      proc,
      ownedPgids: io.ownedPgids(stateDir),
      inspectorPortBusy: busy,
    });
  }
}

/** Filesystem-safe timestamp for the default artifact name. */
function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}
