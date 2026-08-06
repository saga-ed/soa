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
 *
 * FAKE MEDIA (`--fake-video`/`--fake-audio`, soa#363): feed a LOCAL video/audio file into
 * the `--browser` Chromium's camera/mic (for AV flows on a box with no real devices).
 * Chromium's file-backed fake capture reads only raw Y4M video + PCM WAV audio, so any
 * other format (`.mp4`, …) is auto-transcoded via ffmpeg (a `.y4m`/`.wav` input is used
 * as-is). `--fake-video foo.mp4` alone also DERIVES the mic track from the same file.
 * Applies only with `--browser`.
 *
 *   node bin/dev.js stack login empty@saga.org --browser --fake-video ~/clips/student.mp4
 */

import { join, resolve } from 'node:path';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { deriveInstance } from '../../core/derive-instance.js';
import { fakeMediaChromiumArgs } from '../../core/fake-media.js';
import { DEFAULT_LOGIN_USER, loginFailureHint } from '../../core/login.js';
import { SPA_REGISTRY } from '../../core/flow/spa-registry.js';
import type { RepoKey } from '../../core/manifest/index.js';
import { SERVICES } from '../../core/manifest/services.js';
import { prepareFakeMedia } from '../../runtime/index.js';

export default class StackLogin extends BaseCommand {
  static description =
    'Mint a session against the running stack. Native headless cookie jar by default; --browser ALSO opens an auto-logged-in Chromium via the vendored browser-login.mjs.';

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> teacher@saga.org',
    '<%= config.bin %> <%= command.id %> --browser',
    '<%= config.bin %> <%= command.id %> --browser --app coach-web',
    '<%= config.bin %> <%= command.id %> --browser --url http://localhost:8800/reports?org=ist-sc',
    '<%= config.bin %> <%= command.id %> empty@saga.org --browser --fake-video ~/clips/student.mp4',
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
    // Which SPA the --browser Chromium lands on. Until now `stack login --browser`
    // always opened saga-dash, so a Coach (or connectv3) walkthrough handed the
    // reader the WRONG app — and saga-dash's own identity config failing then reads
    // as "login is broken" when the jar is fine. `develop coach` already opens
    // coach-web through the same seam; these two flags expose that to `stack login`.
    app: Flags.string({
      options: Object.keys(SPA_REGISTRY),
      description:
        'which SPA the --browser Chromium opens (default saga-dash). Also sources the Playwright cwd + clone gate from that SPA\'s own repo. The port is slot-aware. Requires --browser.',
    }),
    url: Flags.string({
      description:
        'open the --browser Chromium at this exact URL (deep links welcome). Beats --app and $LOGIN_DASH_URL; leaves Playwright resolution on --app (or saga-dash), so any URL works. Requires --browser.',
    }),
    'fake-video': Flags.string({
      description:
        "feed a LOCAL video file into the --browser Chromium's fake camera (AV flows on a box with no real device). Auto-transcoded to Y4M via ffmpeg (a .y4m file is used as-is); also derives the mic track from this file unless --fake-audio is given. Requires --browser.",
    }),
    'fake-audio': Flags.string({
      description:
        "feed a LOCAL audio file into the --browser Chromium's fake mic. Auto-transcoded to PCM WAV via ffmpeg (a .wav file is used as-is). Overrides the audio derived from --fake-video. Requires --browser.",
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

    // --fake-video/--fake-audio only reach the headful Chromium; without --browser
    // there is nothing to feed them into (soa#363).
    const fakeVideo = flags['fake-video'];
    const fakeAudio = flags['fake-audio'];
    if ((fakeVideo || fakeAudio) && !flags.browser) {
      this.warn('--fake-video/--fake-audio apply only with --browser — ignoring (no headful browser to feed).');
    }
    // Same shape: these only steer the headful Chromium. Warn rather than error —
    // the jar is the command's real product and it is unaffected.
    if ((flags.app !== undefined || flags.url !== undefined) && !flags.browser) {
      this.warn('--app/--url apply only with --browser — ignoring (no headful browser to point anywhere).');
    }

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
      // --app selects the SPA row (its `system` is the manifest service that owns
      // the port, and its repo drives the Playwright cwd); --url overrides the
      // address outright. Default stays saga-dash, so an unflagged invocation is
      // byte-identical to the previous behaviour.
      const spaRow = flags.app === undefined ? undefined : SPA_REGISTRY[flags.app];
      const spaSystem = spaRow?.system ?? 'saga-dash';
      const spaPort = profile.portOverrides[spaSystem] ?? SERVICES[spaSystem]?.port ?? 8900;
      // Explicit --url beats $LOGIN_DASH_URL (a flag is a deliberate act; the env
      // var is ambient tunnel config), which still beats the derived port.
      const dashUrl = flags.url || process.env.LOGIN_DASH_URL || `http://localhost:${spaPort}`;
      const spa =
        spaRow === undefined
          ? undefined
          : // `SpaDescriptor.repoEnvVar` is a plain string in the flow schema; the
            // registry rows are curated and match RepoKey. Same cast `develop coach`
            // makes at its own openVendoredBrowser call site.
            { repoEnvVar: spaRow.repoEnvVar as RepoKey, appDir: spaRow.appDir, port: spaPort };

      // soa#363: transcode any --fake-video/--fake-audio to Chromium capture format and
      // build the launch flags. A prep failure (missing file / ffmpeg / bad transcode) is
      // NON-fatal — the jar is already minted, so warn and open a NORMAL browser rather
      // than abort; the user sees exactly why the fake camera didn't engage.
      let chromiumExtraArgs: string[] = [];
      if (fakeVideo || fakeAudio) {
        try {
          const prepared = await prepareFakeMedia(
            {
              video: fakeVideo ? resolve(process.cwd(), fakeVideo) : undefined,
              audio: fakeAudio ? resolve(process.cwd(), fakeAudio) : undefined,
              outDir: join(stateDir, 'fake-av'),
            },
            { runner: this.getRunner(), notify: (m) => this.log(m) },
          );
          chromiumExtraArgs = fakeMediaChromiumArgs(prepared);
          this.log(
            `  fake media ready — camera${prepared.audio ? ' + mic' : ''} will play ${prepared.video ?? prepared.audio}`,
          );
        } catch (err) {
          this.warn(
            `fake media skipped — ${err instanceof Error ? err.message : String(err)} (opening the browser without it)`,
          );
        }
      }

      await this.openVendoredBrowser(flags, { email, iamUrl, stateDir, dashUrl, spa, chromiumExtraArgs });
    }
  }
}
