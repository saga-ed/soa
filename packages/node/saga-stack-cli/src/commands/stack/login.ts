/**
 * `saga-stack stack login [email]` — mint a session against the running stack.
 *
 * M11: the HEADLESS COOKIE JAR is now NATIVE (the curl half of up.sh's login_user,
 * ~1935-1960). It POSTs iam's dev-only, origin-checked `devLogin` and writes the
 * captured cookies (iam_session JWT + iam_refresh) to a Netscape jar at
 * `<stateDir>/cookies.txt` — exactly what curl `--cookie` / Playwright `storageState`
 * harnesses read. The iam URL is slot-aware (`LOGIN_IAM_URL` overrides for the tunnel).
 *
 * HEADFUL BROWSER (`--browser`): the auto-logged-in Chromium (Playwright) — a native
 * process can't inject HttpOnly cookies into a real browser, so `--browser` routes the
 * FULL flow (jar + Chromium) to `up.sh --login [email]`. It is a purposeful feature
 * flag (open a browser), not a legacy escape; the native headless jar stays the DEFAULT.
 *
 *   node bin/dev.js stack login                         # native headless jar (dev@saga.org)
 *   node bin/dev.js stack login teacher@saga.org        # native headless jar (persona)
 *   node bin/dev.js stack login --browser               # up.sh: jar + headful Chromium
 */

import { join } from 'node:path';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { deriveInstance } from '../../core/derive-instance.js';
import * as flagMap from '../../core/flag-map.js';
import { DEFAULT_LOGIN_USER, loginFailureHint, resolveIamUrl } from '../../core/login.js';
import { COOKIE_JAR_FILE, nativeLogin } from '../../runtime/login.js';

export default class StackLogin extends BaseCommand {
  static description =
    'Mint a session against the running stack. Native headless cookie jar by default; --browser opens an auto-logged-in Chromium via up.sh.';

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> teacher@saga.org',
    '<%= config.bin %> <%= command.id %> --browser',
  ];

  static args = {
    email: Args.string({
      description: 'persona email to log in (defaults to dev@saga.org)',
      required: false,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    browser: Flags.boolean({
      default: false,
      description:
        'open an auto-logged-in Chromium via up.sh --login (headless jar + headful browser). The default mints only the native headless cookie jar.',
    }),
  };

  /** M11: the native jar is slot-aware (offset iam URL + per-slot state dir). */
  protected slotAware(): boolean {
    return true;
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parse(StackLogin);

    // ── --browser: the full headful flow via up.sh (hardcoded to slot 0). ──
    if (flags.browser) {
      if (flags.slot > 0) {
        this.error(
          `slot ${flags.slot}: --browser routes through up.sh --login, which is hardcoded to slot 0 ` +
            '(IAM :3010, STATE=/tmp/sds-synthetic). Drop --browser to mint the slot\'s headless jar natively.',
        );
      }
      await this.runScript(flagMap.login(args.email), flags);
      return;
    }

    // ── NATIVE: the headless cookie jar (browser half stays delegated). ──
    const email = args.email ?? DEFAULT_LOGIN_USER;
    const profile = deriveInstance({ slot: flags.slot });
    const stateDir = flags['state-dir'] ?? profile.stateDir;
    // LOGIN_IAM_URL wins (tunnel: login goes through the PUBLIC iam host); else slot-offset localhost.
    const iamUrl = resolveIamUrl({ slot: flags.slot, loginIamUrl: process.env.LOGIN_IAM_URL });
    const jarPath = join(stateDir, COOKIE_JAR_FILE);

    const res = await nativeLogin(
      { email, iamUrl, jarPath },
      { poster: this.getCookiePoster(), jar: this.getJarWriter() },
    );

    const json: Record<string, unknown> = {
      native: true,
      ok: res.ok,
      status: res.status,
      email,
      iamUrl,
      jarPath,
      captured: res.captured,
      browserDelegated: true,
    };

    if (!res.ok) {
      // A non-200 surfaces the persona/ordering hint (login-after-seed) — never a crash.
      this.emit(flags, json, [
        ...loginFailureHint(email, res.status),
        '  The headful browser auto-login is available via `stack login --browser`.',
      ]);
      this.exit(1);
      return;
    }

    this.emit(flags, json, [
      `✓ session minted — cookie jar → ${jarPath} (headless harnesses: curl --cookie / Playwright storageState)`,
      `  cookies: ${res.captured.join(', ') || '(none)'}`,
      '  `stack login --browser` opens an auto-logged-in Chromium.',
    ]);
  }
}
