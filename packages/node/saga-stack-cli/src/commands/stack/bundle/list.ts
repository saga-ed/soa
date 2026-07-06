/**
 * `saga-stack stack bundle list` — enumerate the `--with` convenience bundles
 * (saga-ed/soa#214). Read-only; prints the bundle registry (`core/bundles`) so a
 * caller can see what each `--with <name>` pulls in before running `stack up`.
 *
 * Columns: NAME, SERVICES (comma list, or `seed-only` for a service-less bundle
 * like qtf), SEED (the seed add-on, or `—`), DESCRIPTION. Supports the shared
 * `--output-json` / `--porcelain` read-only output modes.
 *
 *   node bin/dev.js stack bundle list
 *   node bin/dev.js stack bundle list --output-json
 */

import { BaseCommand } from '../../../base-command.js';
import { BUNDLES, BUNDLE_NAMES } from '../../../core/bundles.js';

export default class BundleList extends BaseCommand {
  static description =
    'List the --with convenience bundles (name, services, seed add-on, description). Read-only.';

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --output-json',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(BundleList);

    const rows = BUNDLE_NAMES.map((name) => {
      const def = BUNDLES[name];
      return {
        name,
        services: [...def.services],
        seedAddOn: def.seedAddOn ?? null,
        description: def.description,
      };
    });

    if (flags['output-json']) {
      this.log(JSON.stringify(rows, null, 2));
      return;
    }

    if (flags.porcelain) {
      for (const r of rows) {
        this.log(`${r.name}\t${r.services.join(',')}\t${r.seedAddOn ?? ''}\t${r.description}`);
      }
      return;
    }

    // ── Aligned table sized to the data. ──
    const svcText = (r: (typeof rows)[number]): string =>
      r.services.length > 0 ? r.services.join(', ') : 'seed-only';
    const nameW = Math.max(4, ...rows.map((r) => r.name.length));
    const svcW = Math.max(8, ...rows.map((r) => svcText(r).length));
    const seedW = Math.max(4, ...rows.map((r) => (r.seedAddOn ?? '—').length));
    const row = (name: string, svc: string, seed: string, desc: string): string =>
      `  ${name.padEnd(nameW)}  ${svc.padEnd(svcW)}  ${seed.padEnd(seedW)}  ${desc}`;

    this.log('Convenience bundles (use with `stack up --with <name>`):');
    this.log('');
    const header = row('NAME', 'SERVICES', 'SEED', 'DESCRIPTION');
    this.log(header);
    this.log('  ' + '─'.repeat(header.length - 2));

    for (const r of rows) {
      this.log(row(r.name, svcText(r), r.seedAddOn ?? '—', r.description));
    }

    this.log('');
    this.log('  Compose them: `stack up --with dash --with playback`. Also honoured by stack status / verify.');
  }
}
