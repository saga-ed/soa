/**
 * `--workspace <file.json>` parser (Phase 2, saga-ed/soa#214) — a PURE port of
 * up.sh's `parse_workspace()` (~1150-1214).
 *
 * A switchboard-exported workspace manifest selects, per service, a run MODE
 * (`local-source` = run it from source locally / `sandbox` = it lives in a cloud
 * sandbox) plus an optional DB profile. This module maps that JSON — already read
 * + `JSON.parse`d by the command (the ONLY IO is there) — into the native launch
 * selection: which services to bring up (`runSet`), whether iam-api is
 * sandbox-hosted (`iamSandbox`, which drives the `sandbox_env` overlay), whether
 * the playback trio is implied, and the per-service DB profiles. It performs ZERO
 * IO, so the golden parse tests need no filesystem/jq.
 *
 * FAITHFUL to up.sh:
 *  - `local-image` is a valid manifest mode but REJECTED (the local docker-run
 *    launcher is unbuilt) — throws, never half-runs.
 *  - a non-iam sandbox entry is recorded but WARNED (dep-repoint is iam-only today).
 *  - version != "1" warns (proceeds); missing/empty `.services` throws.
 */

import type { ServiceId } from './manifest/index.js';

/** One service entry in a workspace manifest. */
export interface WorkspaceServiceEntry {
  mode?: string;
  sandboxName?: string;
  dbProfile?: string;
}

/** The raw (already-`JSON.parse`d) workspace manifest shape. */
export interface WorkspaceManifest {
  version?: string | number;
  services?: Record<string, WorkspaceServiceEntry>;
}

/** The native launch selection a workspace manifest resolves to. */
export interface WorkspaceSelection {
  /** `local-source` services to bring up locally (up.sh `WS_RUN_SET`), declaration order. */
  runSet: ServiceId[];
  /** iam-api's sandbox name when it is sandbox-hosted (drives `sandbox_env`); else undefined. */
  iamSandbox?: string;
  /**
   * EVERY service id in `sandbox` mode (up.sh `SVC_SANDBOX` keys) — they live in the
   * cloud sandbox, so `runNative` SUBTRACTS them from the local launch set (a
   * sandboxed dep pulled into the closure must NOT boot locally; parity with
   * up.sh's `want_service`, which launches only `WS_RUN_SET`). Declaration order.
   */
  sandboxServices: ServiceId[];
  /** True iff any playback API (insights/transcripts/chat) is in the run set (up.sh `DO_PLAYBACK`). */
  playback: boolean;
  /** Per-service DB-restore profiles (up.sh `SVC_DBPROFILE`) for local-source services. */
  dbProfiles: Record<string, string>;
  /** Non-fatal notes (recorded-but-unwired sandbox deps, version mismatch). */
  warnings: string[];
}

const PLAYBACK_APIS = new Set<ServiceId>(['insights-api', 'transcripts-api', 'chat-api']);

/**
 * Parse an already-`JSON.parse`d workspace manifest into a `WorkspaceSelection`.
 * Throws `Error` on the fatal conditions up.sh `err`s on (unsupported mode,
 * invalid mode, sandbox entry with no name, no services); the command turns the
 * message into `this.error`.
 */
export function parseWorkspace(manifest: WorkspaceManifest): WorkspaceSelection {
  const warnings: string[] = [];

  // up.sh warns for ANY version != "1" — INCLUDING an empty/missing one (`.version //
  // empty` → "" → the `[[ "$ver" == "1" ]]` gate fails and warns). Mirror that: warn
  // whenever the resolved version string is not exactly "1".
  const version = manifest.version === undefined ? '' : String(manifest.version);
  if (version !== '1') {
    warnings.push(`--workspace: version '${version}' (expected 1) — proceeding`);
  }

  const services = manifest.services;
  if (!services || typeof services !== 'object' || Object.keys(services).length === 0) {
    throw new Error("--workspace: '.services' is empty or missing");
  }

  const runSet: ServiceId[] = [];
  const sandboxServices: ServiceId[] = [];
  const dbProfiles: Record<string, string> = {};
  let iamSandbox: string | undefined;

  for (const [svc, entry] of Object.entries(services)) {
    const mode = entry?.mode ?? '';
    switch (mode) {
      case 'local-source': {
        runSet.push(svc as ServiceId);
        // A dbProfile means "restore this service's DB from the matching snapshot
        // instead of seeding from scratch" — recorded here, validated by the restore.
        if (entry.dbProfile) dbProfiles[svc] = entry.dbProfile;
        break;
      }
      case 'sandbox': {
        if (!entry.sandboxName) {
          throw new Error(`--workspace: service '${svc}' is sandbox but carries no sandboxName`);
        }
        // Record EVERY sandbox-mode id (up.sh `SVC_SANDBOX`) so runNative subtracts it
        // from the local launch set — the sandboxed service lives in the cloud.
        sandboxServices.push(svc as ServiceId);
        if (svc === 'iam-api') {
          iamSandbox = entry.sandboxName;
        } else {
          // Only iam-api's dep URL is repointed today (sandbox_env); a non-iam
          // sandbox is recorded but a local dependant still hits its default.
          warnings.push(
            `--workspace: '${svc}' sandbox is recorded but dep-repoint is iam-only today; local services depending on it keep their default (Phase 3)`,
          );
        }
        break;
      }
      case 'local-image':
        // A valid forward-compatible manifest mode, but the local docker-run
        // launcher is unbuilt — reject loudly rather than half-run it.
        throw new Error(
          `--workspace: service '${svc}' is local-image — not supported yet (Phase 2). Use local-source or sandbox.`,
        );
      default:
        throw new Error(`--workspace: service '${svc}' has invalid mode '${mode}'`);
    }
  }

  if (runSet.length === 0) {
    warnings.push('--workspace: no local services to run (all sandbox-hosted) — nothing will launch locally');
  }

  // Native seeds every local DB from scratch; up.sh's dbProfile → S3 restore is
  // NOT ported (Phase 3). Surface a one-line warning so a dbProfile entry silently
  // seeding-from-scratch isn't an unflagged divergence from up.sh's restore.
  if (Object.keys(dbProfiles).length > 0) {
    warnings.push(
      `--workspace: dbProfile entries are ignored (native seeds from scratch; up.sh restores from S3 — Phase 3): ${Object.keys(dbProfiles).join(', ')}`,
    );
  }

  const playback = runSet.some((s) => PLAYBACK_APIS.has(s));

  return { runSet, iamSandbox, sandboxServices, playback, dbProfiles, warnings };
}
