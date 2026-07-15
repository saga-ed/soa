/**
 * `ss frontend up <label>=<path> [--port N] [--slot S]` — launch an extra
 * saga-dash dev server (from the caller's checkout) against the stack at slot S.
 *
 * A variant is another launch of the `saga-dash` service via the real launcher
 * with three overrides — a distinct pidfile id (`saga-dash@<label>`), the
 * variant's checkout as cwd, and its own port — so `stack down` reaps it like any
 * service. The `sync-dash-local-defaults` hook wires the variant's config.local.json
 * to slot S's backend (removed at slot 0 → base ports; written at slot > 0). The
 * variant is recorded in `<stateDir>/frontends.json` for `frontend browser`.
 */

import { join, resolve } from 'node:path';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { deriveInstance } from '../../core/derive-instance.js';
import {
  MAX_VARIANTS_PER_SLOT,
  frontendServiceId,
  parseVariantArg,
  reservedServicePorts,
  variantHealthUrl,
  variantLaunchArgs,
  variantPortCandidates,
} from '../../core/frontend-variant.js';
import { getService } from '../../core/manifest/index.js';
import { syncDashLocalDefaults } from '../../runtime/dash-defaults.js';
import { readRegistry, upsertRegistry } from '../../runtime/frontend-registry.js';
import { resolveRepoRoot } from '../../runtime/scripts.js';

export default class FrontendUp extends BaseCommand {
  static description =
    'Launch an extra saga-dash version (from a supplied checkout) against the running stack.';

  static examples = [
    '<%= config.bin %> <%= command.id %> feat=/home/me/saga-dash-feat',
    '<%= config.bin %> <%= command.id %> feat=/home/me/saga-dash-feat --port 8950 --slot 1',
  ];

  static args = {
    variant: Args.string({ description: 'label=path (e.g. feat=/home/me/saga-dash-feat)', required: true }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    port: Flags.integer({ min: 1, description: 'pin the dev-server port (default: auto-assigned)' }),
  };

  protected slotAware(): boolean {
    return true;
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parse(FrontendUp);
    const { label, path: rawPath } = parseVariantArg(args.variant);
    const checkout = resolve(rawPath);

    const profile = deriveInstance({ slot: flags.slot });
    const stateDir = flags['state-dir'] ?? profile.stateDir;
    const dashBase = profile.portOverrides['saga-dash'] ?? 8900;

    // Validate the checkout has a dash app.
    const dashAppDir = join(checkout, 'apps', 'web', 'dash');
    if (!this.getRepoDirCheck()(dashAppDir)) {
      this.error(`no saga-dash app at ${dashAppDir} — pass the checkout ROOT (…/saga-dash)`);
    }

    // Guard: not the primary checkout, not a dup label/path.
    const primary = resolve(resolveRepoRoot('SAGA_DASH', this.scriptContextFromFlags(flags)));
    if (checkout === primary) {
      this.error(`${checkout} is the primary saga-dash checkout (already the stack's :${dashBase} dash)`);
    }
    const reg = readRegistry(stateDir, this.getFrontendRegistryIo());
    if (reg[label]) {
      this.error(`frontend "${label}" is already running at slot ${flags.slot} (port ${reg[label].port})`);
    }
    if (Object.values(reg).some((r) => resolve(r.path) === checkout)) {
      this.error(`${checkout} is already running under another label at slot ${flags.slot}`);
    }
    if (Object.keys(reg).length >= MAX_VARIANTS_PER_SLOT) {
      this.error(`slot ${flags.slot} already has ${MAX_VARIANTS_PER_SLOT} frontends (the cap)`);
    }

    // Choose the port.
    const probe = this.getPortProbe();
    const occupied = new Set<number>(Object.values(reg).map((r) => r.port));
    let port: number;
    if (flags.port !== undefined) {
      if (occupied.has(flags.port) || (await probe.listening(flags.port))) {
        this.error(`port ${flags.port} is already in use`);
      }
      port = flags.port;
    } else {
      port = 0;
      for (const cand of variantPortCandidates(dashBase, reservedServicePorts(), occupied)) {
        if (!(await probe.listening(cand))) {
          port = cand;
          break;
        }
      }
      if (port === 0) this.error(`no free port found in slot ${flags.slot}'s band`);
    }

    // Wire the variant's backend config for slot S (removed at slot 0, written at slot > 0).
    syncDashLocalDefaults(
      { sagaDashRoot: checkout, tunnel: false, slot: flags.slot, stackPorts: profile.portOverrides },
      this.getDashFs(),
    );

    // Launch it as saga-dash@<label>.
    const id = frontendServiceId(label);
    const res = await this.getLauncher(stateDir).launch({
      id,
      cwd: dashAppDir,
      command: 'pnpm',
      args: variantLaunchArgs(port),
      env: { ...getService('saga-dash').launch.env },
      healthUrl: variantHealthUrl(port),
    });

    upsertRegistry(
      stateDir,
      { label, path: checkout, port, pid: res.pid ?? 0, slot: flags.slot },
      this.getFrontendRegistryIo(),
    );

    this.emit(
      flags,
      { id, label, path: checkout, port, slot: flags.slot, ok: res.ok, pid: res.pid ?? null },
      [
        `${res.ok ? '✓' : '⚠'} frontend "${label}" → http://localhost:${port} (${id}, slot ${flags.slot})`,
        `  open it: ss frontend browser ${label}${flags.slot ? ` --slot ${flags.slot}` : ''}`,
      ],
    );
  }
}
