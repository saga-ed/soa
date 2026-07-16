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

import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { deriveInstance } from '../../core/derive-instance.js';
import { DEFAULT_LOGIN_USER, loginFailureHint } from '../../core/login.js';

export default class StackLogin extends BaseCommand {
  static description =
    'Mint a session against the running stack. Native headless cookie jar by default; --browser ALSO opens an auto-logged-in Chromium via the vendored browser-login.mjs.';

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

  /** Slot claims: minting the jar writes slot state — record the advisory claim on entry. */
  protected claimsSlot(): boolean {
    return true;
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parse(StackLogin);

    // ── NATIVE headless cookie jar (BOTH the default AND the --browser path). ──
    // Shared with `up --login` via the BaseCommand helper — NEITHER touches up.sh.
    const email = args.email ?? DEFAULT_LOGIN_USER;
    const profile = deriveInstance({ slot: flags.slot });
    const stateDir = flags['state-dir'] ?? profile.stateDir;

    const res = await this.mintNativeLoginJar({ email, slot: flags.slot, stateDir });
    const { iamUrl, jarPath } = res;

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

    // ── --browser: ALSO open the headful Chromium via the shared VENDORED browser-login.mjs
    // helper (BaseCommand.openVendoredBrowser) — the same one `up --login` uses. ──
    if (flags.browser) {
      // Point the browser at the SLOT's own dash (base 8900 + slot*1000, from the
      // resolved profile). LOGIN_DASH_URL still wins for the tunnel case. iamUrl and
      // stateDir (⇒ PROFILE_DIR) are already slot-aware; the per-slot stateDir gives a
      // distinct persistent profile per slot. At slot 0 dashPort is 8900, so this is
      // byte-identical to the previous slot-0-only behaviour.
      const dashPort = profile.portOverrides['saga-dash'] ?? 8900;
      const dashUrl = process.env.LOGIN_DASH_URL || `http://localhost:${dashPort}`;
      await this.openVendoredBrowser(flags, { email, iamUrl, stateDir, dashUrl });
    }
  }
}
