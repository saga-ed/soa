/**
 * `saga-stack stack login [email]` — mint a session against the running stack.
 *
 * M11: the HEADLESS COOKIE JAR is now NATIVE (the curl half of up.sh's login_user,
 * ~1935-1960). It POSTs iam's dev-only, origin-checked `devLogin` and writes the
 * captured cookies (iam_session JWT + iam_refresh) to a Netscape jar at
 * `<stateDir>/cookies.txt` — exactly what curl `--cookie` / Playwright `storageState`
 * harnesses read. The iam URL is slot-aware (`LOGIN_IAM_URL` overrides for the tunnel).
 *
 * HEADFUL BROWSER (`--browser`): the auto-logged-in Chromium (Playwright). A native
 * process can't inject HttpOnly cookies into a real browser, so `--browser` FIRST mints
 * the native headless jar (same as the default), THEN opens a real Chromium via the CLI's
 * VENDORED `browser-login.mjs` (Phase 1 DECOUPLING, saga-ed/soa#214) — NOT `up.sh --login`.
 * It is a purposeful feature flag (open a browser), not a legacy escape; the native
 * headless jar stays the DEFAULT.
 *
 * PLAYWRIGHT RESOLUTION: browser-login.mjs `createRequire`s `playwright` from
 * `SAGA_DASH_DASH/package.json` (saga-dash's dash app, where playwright is installed),
 * so we set `SAGA_DASH_DASH=<saga-dash>/apps/web/dash` AND run node with `cwd` = that
 * dir — playwright (and its browser binaries) resolve there regardless of where `ss` runs.
 *
 *   node bin/dev.js stack login                         # native headless jar (dev@saga.org)
 *   node bin/dev.js stack login teacher@saga.org        # native headless jar (persona)
 *   node bin/dev.js stack login --browser               # native jar + vendored browser-login.mjs
 */

import { join } from 'node:path';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import type { WorkspaceFlags } from '../../base-command.js';
import { deriveInstance } from '../../core/derive-instance.js';
import { DEFAULT_LOGIN_USER, loginFailureHint, resolveIamUrl } from '../../core/login.js';
import { COOKIE_JAR_FILE, nativeLogin } from '../../runtime/login.js';
import { resolveRepoRoot, resolveVendorScript } from '../../runtime/index.js';
import { repoContextFromFlags } from './status.js';

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
        'ALSO open an auto-logged-in Chromium via the vendored browser-login.mjs (native headless jar + headful browser). The default mints only the native headless cookie jar.',
    }),
  };

  /** M11: the native jar is slot-aware (offset iam URL + per-slot state dir). */
  protected slotAware(): boolean {
    return true;
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parse(StackLogin);

    // --browser opens a Chromium against slot 0's dash (DASH :8900, PROFILE under
    // /tmp/sds-synthetic). browser-login.mjs is not slot-parameterised, so refuse
    // --browser at slot > 0 rather than open a window pointed at slot 0's dash.
    if (flags.browser && flags.slot > 0) {
      this.error(
        `slot ${flags.slot}: --browser opens a Chromium against slot 0's dash (DASH :8900, ` +
          "PROFILE under /tmp/sds-synthetic). Drop --browser to mint the slot's headless jar natively.",
      );
    }

    // ── NATIVE headless cookie jar (BOTH the default AND the --browser path). ──
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
      browser: flags.browser,
    };

    if (!res.ok) {
      // A non-200 surfaces the persona/ordering hint (login-after-seed) — never a crash.
      // The jar failed, so we do NOT open the browser (parity with up.sh's login_user,
      // which only opens the browser after a successful devLogin).
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
      flags.browser
        ? '  opening an auto-logged-in Chromium (vendored browser-login.mjs)…'
        : '  `stack login --browser` opens an auto-logged-in Chromium.',
    ]);

    // ── --browser: ALSO open the headful Chromium via the VENDORED browser-login.mjs. ──
    if (flags.browser) {
      await this.openVendoredBrowser(flags, { email, iamUrl, stateDir });
    }
  }

  /**
   * Open the auto-logged-in headful Chromium via the CLI's VENDORED `browser-login.mjs`
   * (Phase 1 DECOUPLING) — replacing up.sh's `open_login_browser`. Passes the exact env
   * browser-login.mjs reads: `IAM_URL` (the resolved slot-0 / LOGIN_IAM_URL iam host),
   * `DASH_URL` (LOGIN_DASH_URL override else localhost:8900), `LOGIN_EMAIL` (the persona),
   * `PROFILE_DIR` (`<stateDir>/browser-profile`, up.sh's BROWSER_PROFILE), and
   * `SAGA_DASH_DASH` (the resolved saga-dash dash app dir). node runs with `cwd` = that
   * dash dir so `createRequire`'d playwright + its browsers resolve there.
   *
   * BEST-EFFORT (`propagateExit:false`): the headless jar is already minted, so a browser
   * failure (playwright not installed, no DISPLAY, …) — which browser-login.mjs reports as
   * an `AUTOLOGIN_FAIL` line on the inherited stdio — must NOT flip the login's exit code,
   * mirroring up.sh's best-effort browser step. Unlike up.sh (which nohup-backgrounds the
   * browser), this runs in the FOREGROUND: the command stays attached to the headful
   * Chromium and returns when the window is closed (headless verification exits at once).
   */
  private async openVendoredBrowser(
    flags: WorkspaceFlags,
    ctx: { email: string; iamUrl: string; stateDir: string },
  ): Promise<void> {
    const script = resolveVendorScript('browser-login.mjs');
    const sagaDashDash = join(
      resolveRepoRoot('SAGA_DASH', repoContextFromFlags(flags as unknown as Record<string, unknown>)),
      'apps',
      'web',
      'dash',
    );
    const env: Record<string, string> = {
      IAM_URL: ctx.iamUrl,
      DASH_URL: process.env.LOGIN_DASH_URL || 'http://localhost:8900',
      LOGIN_EMAIL: ctx.email,
      PROFILE_DIR: join(ctx.stateDir, 'browser-profile'),
      SAGA_DASH_DASH: sagaDashDash,
    };
    await this.runVendor(
      { cwd: sagaDashDash, command: 'node', args: [script], env },
      flags,
      { propagateExit: false },
    );
  }
}
