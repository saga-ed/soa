/**
 * `saga-stack stack login [email]` — mint a session against the running stack.
 *
 * M11: the HEADLESS COOKIE JAR is now NATIVE (the curl half of up.sh's login_user,
 * ~1935-1960). It POSTs iam's dev-only, origin-checked `devLogin` and writes the
 * captured cookies (iam_session JWT + iam_refresh) to a Netscape jar at
 * `<stateDir>/cookies.txt` — exactly what curl `--cookie` / Playwright `storageState`
 * harnesses read. The iam URL is slot-aware (`LOGIN_IAM_URL` overrides for the tunnel).
 *
 * STILL DELEGATED (plan §2.3): the HEADFUL BROWSER auto-login (Playwright) — a native
 * process can't inject HttpOnly cookies into a real browser, so `--legacy` routes the
 * FULL flow (jar + Chromium) to `up.sh --login [email]`.
 *
 *   node bin/dev.js stack login                         # native headless jar (dev@saga.org)
 *   node bin/dev.js stack login teacher@saga.org        # native headless jar (persona)
 *   node bin/dev.js stack login --legacy                # up.sh: jar + headful Chromium
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
    'Mint a session against the running stack. Native headless cookie jar by default; --legacy adds the headful Chromium via up.sh.';

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> teacher@saga.org',
    '<%= config.bin %> <%= command.id %> --legacy',
  ];

  static args = {
    email: Args.string({
      description: 'persona email to log in (defaults to dev@saga.org)',
      required: false,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    legacy: Flags.boolean({
      default: false,
      description:
        'route the FULL login (headless jar + headful Chromium auto-login) to up.sh --login. Native login mints only the headless cookie jar.',
    }),
  };

  /** M11: the native jar is slot-aware (offset iam URL + per-slot state dir). */
  protected slotAware(): boolean {
    return true;
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parse(StackLogin);

    // ── LEGACY: the full headful flow via up.sh (hardcoded to slot 0). ──
    if (flags.legacy) {
      if (flags.slot > 0) {
        this.error(
          `slot ${flags.slot}: --legacy routes through up.sh --login, which is hardcoded to slot 0 ` +
            '(IAM :3010, STATE=/tmp/sds-synthetic). Drop --legacy to mint the slot\'s headless jar natively.',
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
        '  The headful browser auto-login stays delegated — run `stack login --legacy` for it.',
      ]);
      this.exit(1);
      return;
    }

    this.emit(flags, json, [
      `✓ session minted — cookie jar → ${jarPath} (headless harnesses: curl --cookie / Playwright storageState)`,
      `  cookies: ${res.captured.join(', ') || '(none)'}`,
      '  headful browser auto-login stays delegated — `stack login --legacy` opens an auto-logged-in Chromium.',
    ]);
  }
}
