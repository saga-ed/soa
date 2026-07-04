/**
 * `saga-stack stack tunnel <verb>` — expose the local stack via the vms
 * rendezvous box (M2 thin wrapper over tunnel.sh).
 *
 * Verbs are tunnel.sh's own dispatch (`case "${1:-up}"`):
 *   up            start the reverse tunnels (bootstraps the moniker on first run)
 *   down          stop the tunnels
 *   status        tunnel process + per-URL health probes
 *   moniker       print the moniker (bootstrapping it if absent)
 *   urls          print the public URL table
 *   aws-profile   print the resolved dev-account AWS profile (sibling tooling reads it)
 *
 * MONIKER IS NEVER A FLAG. tunnel.sh refuses the moniker on argv on purpose (a
 * placeholder in a shared command cross-contaminates stacks) and prompts on the
 * TTY on first use. So the command spawns with stdio inherited (BaseCommand's
 * runner default) for EVERY verb — the moniker prompt and frpc progress own the
 * user's terminal, exactly like the script. `AWS_PROFILE` is resolved by
 * tunnel.sh itself from the ambient env, so it is not surfaced as a flag.
 *
 * DECOUPLING (Phase 1, saga-ed/soa#214): the script is now the CLI's VENDORED copy
 * (`vendor/tunnel.sh`), resolved via `resolveVendorScript` — NOT `soa`'s
 * `tools/synthetic-dev/tunnel.sh`. tunnel.sh reads/writes its `.vms-moniker`
 * ALONGSIDE itself (`SCRIPT_DIR=dirname($0)`), so the moniker now lives next to the
 * vendored copy (`vendor/.vms-moniker`) rather than in the soa checkout. The
 * flag→argv/env mapping (`flagMap.tunnel`) is unchanged; only the path is repointed.
 *
 *   node bin/dev.js stack tunnel up
 *   node bin/dev.js stack tunnel status
 *   node bin/dev.js stack tunnel moniker
 */

import { dirname } from 'node:path';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import * as flagMap from '../../core/flag-map.js';
import type { TunnelVerb } from '../../core/flag-map.js';
import { resolveVendorScript } from '../../runtime/index.js';

const VERBS: readonly TunnelVerb[] = ['up', 'down', 'status', 'moniker', 'urls', 'aws-profile'];

export default class StackTunnel extends BaseCommand {
  static description =
    'Expose the local synthetic-dev stack via the vms rendezvous box (wraps tunnel.sh).';

  static examples = [
    '<%= config.bin %> <%= command.id %> up',
    '<%= config.bin %> <%= command.id %> status',
    '<%= config.bin %> <%= command.id %> moniker',
  ];

  static args = {
    verb: Args.string({
      description: 'tunnel action (moniker is prompted on the TTY, never taken as a flag)',
      options: [...VERBS],
      default: 'up',
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    'vms-base': Flags.string({
      description: 'rendezvous domain (tunnel.sh env VMS_BASE; default vms.wootdev.com)',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(StackTunnel);
    // Reuse the pure flag→argv/env mapping, but RESOLVE + RUN the VENDORED copy
    // (vendor/tunnel.sh) instead of soa's tools/synthetic-dev/tunnel.sh.
    const plan = flagMap.tunnel(args.verb as TunnelVerb, { vmsBase: flags['vms-base'] });
    const script = resolveVendorScript('tunnel.sh');
    await this.runVendor({ cwd: dirname(script), command: script, args: plan.args, env: plan.env }, flags);
  }
}
