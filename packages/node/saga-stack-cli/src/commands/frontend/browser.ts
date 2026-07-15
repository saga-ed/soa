/**
 * `ss frontend browser [<label>[,<label2>…]] [--slot S]` — open the slot-S
 * frontends as tabs in ONE logged-in browser.
 *
 * No labels ⇒ every running variant at slot S. The special label `primary` maps
 * to the stack's own dash (`dashBase`). SINGLE-SLOT INVARIANT: all tabs share one
 * profile + one devLogin, so every requested label must be at slot S (one backend
 * ⇒ one iam ⇒ one login). Delegates the open to `openFrontendBrowser`.
 */

import { Args } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { deriveInstance } from '../../core/derive-instance.js';
import { DEFAULT_LOGIN_USER, resolveIamUrl } from '../../core/login.js';
import { readRegistry } from '../../runtime/frontend-registry.js';

export default class FrontendBrowser extends BaseCommand {
  static description = 'Open one or more frontend variants (of one slot) as tabs in a single logged-in browser.';

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> primary,feat',
    '<%= config.bin %> <%= command.id %> feat --slot 1',
  ];

  static args = {
    labels: Args.string({ description: 'comma-separated labels (default: all at this slot; `primary` = the stack dash)', required: false }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
  };

  protected slotAware(): boolean {
    return true;
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parse(FrontendBrowser);
    const profile = deriveInstance({ slot: flags.slot });
    const stateDir = flags['state-dir'] ?? profile.stateDir;
    const dashBase = profile.portOverrides['saga-dash'] ?? 8900;
    const reg = readRegistry(stateDir, this.getFrontendRegistryIo());

    const requested = args.labels
      ? args.labels.split(',').map((l) => l.trim()).filter(Boolean)
      : Object.keys(reg);

    const urls: string[] = [];
    for (const label of requested) {
      if (label === 'primary') {
        urls.push(`http://localhost:${dashBase}`);
        continue;
      }
      const rec = reg[label];
      if (!rec) {
        this.error(
          `no frontend "${label}" at slot ${flags.slot} — run \`ss frontend up ${label}=<path>${
            flags.slot ? ` --slot ${flags.slot}` : ''
          }\` first`,
        );
      }
      urls.push(`http://localhost:${rec.port}`);
    }

    if (urls.length === 0) {
      this.error(
        `no frontends to open at slot ${flags.slot} — run \`ss frontend up <label>=<path>\` first, or pass \`primary\``,
      );
    }

    this.emit(flags, { slot: flags.slot, urls }, [
      `opening ${urls.length} tab(s) in one logged-in browser (slot ${flags.slot}): ${urls.join(', ')}`,
    ]);

    await this.openFrontendBrowser(flags, {
      iamUrl: resolveIamUrl({ slot: flags.slot, loginIamUrl: process.env.LOGIN_IAM_URL }),
      stateDir,
      urls,
      email: DEFAULT_LOGIN_USER,
    });
  }
}
