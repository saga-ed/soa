/**
 * `saga-stack version` — print the CLI's runtime-derived version (soa#341).
 *
 * `1.0.<n>+<sha>[.dirty]`: major.minor from package.json, patch = commit count
 * of the CLI package at HEAD (see runtime/cli-version.ts for the full design).
 * Also reachable as `ss -v` / `ss --version` via the init hook
 * (src/hooks/init/version-flag.ts). Read-only; never exits non-zero — a
 * git-less environment folds to the static package.json version.
 */

import { BaseCommand } from '../base-command.js';
import { dim } from '../color.js';
import { computeCliVersion } from '../runtime/index.js';

export default class Version extends BaseCommand {
  static description =
    'Print the CLI version: major.minor from package.json, auto-incrementing patch = commit count of the CLI package (+short sha, .dirty when the checkout has uncommitted changes).';

  static examples = [
    '<%= config.bin %> version',
    '<%= config.bin %> -v',
    '<%= config.bin %> version --output-json',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Version);
    const v = await computeCliVersion({
      pkgVersion: this.config.version,
      pkgRoot: this.config.root,
      git: this.getGitRunner(),
    });

    if (flags['output-json']) {
      this.log(
        JSON.stringify(
          {
            version: v.semver,
            base: v.base,
            patch: v.patch,
            sha: v.sha,
            dirty: v.dirty,
            node: process.version,
            platform: `${process.platform}-${process.arch}`,
          },
          null,
          2,
        ),
      );
      return;
    }
    if (flags.porcelain) {
      this.log(v.semver);
      return;
    }
    this.log(`${this.config.bin} ${v.semver}`);
    this.log(dim(`${process.platform}-${process.arch} node ${process.version}`));
  }
}
