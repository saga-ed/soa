// Datadog RUM wrapper with Saga conventions.
//
// One service per app:  initRum({ service: 'saga_dash' | 'qboard_connectv3' | 'janus_login', ... })
//
// Singleton — only the first initRum call has any effect. Pass an empty
// applicationId or clientToken (e.g. when env vars aren't set in local dev)
// and the entire module silently no-ops; subsequent setRumUser / addRumError /
// addRumAction calls return without throwing.

import { datadogRum, type RumInitConfiguration } from '@datadog/browser-rum';

export interface InitRumOptions {
  /** Service tag baked into every error/action. Use `<service>` per the fleet's RUM-app strategy. */
  service: string;
  /** Datadog RUM application id. Empty string is treated as "not configured" and disables RUM. */
  applicationId: string;
  /** Datadog RUM client token (the `pub*`-prefixed bundle-safe one). Empty string disables RUM. */
  clientToken: string;
  /** `dev` / `staging` / `prod`. */
  env: string;
  /** Build version baked into every event. */
  version: string;
  /** Datadog site. Defaults to `datadoghq.com` (US1). */
  site?: RumInitConfiguration['site'];
  /** % of sessions to track. Default 100 during stabilization. */
  sessionSampleRate?: number;
  /** % of tracked sessions to record (session replay). Default 5. */
  sessionReplaySampleRate?: number;
  /** Default 'mask' to match nimbee. */
  defaultPrivacyLevel?: RumInitConfiguration['defaultPrivacyLevel'];
  /** Backend domains to inject `traceparent` headers into. */
  allowedTracingUrls?: RumInitConfiguration['allowedTracingUrls'];
  /** Default true. */
  trackUserInteractions?: boolean;
  /** Default true. */
  trackResources?: boolean;
  /** Default true. */
  trackLongTasks?: boolean;
}

export interface RumUserPatch {
  id?: string;
  name?: string;
  email?: string;
  /** Saga org / tenant id. Surfaces as `@usr.org` in the Session Explorer. */
  org?: string;
  /** Saga role enum (e.g. SCHOLAR, TUTOR, SITE_DIRECTOR). Surfaces as `@usr.role`. */
  role?: string;
  /** Any extra fields a consumer wants on the RUM user. */
  [key: string]: string | number | boolean | undefined;
}

let initialized = false;
let service = '';

/**
 * Initialize Datadog RUM. Idempotent — second and subsequent calls are no-ops.
 * Returns false (silent no-op) if applicationId or clientToken is empty so that
 * builds without RUM env vars wired up still ship cleanly.
 */
export function initRum(opts: InitRumOptions): boolean {
  if (initialized) return true;
  if (!opts.applicationId || !opts.clientToken) return false;

  try {
    datadogRum.init({
      applicationId: opts.applicationId,
      clientToken: opts.clientToken,
      site: opts.site ?? 'datadoghq.com',
      service: opts.service,
      env: opts.env,
      version: opts.version,
      sessionSampleRate: opts.sessionSampleRate ?? 100,
      sessionReplaySampleRate: opts.sessionReplaySampleRate ?? 5,
      trackUserInteractions: opts.trackUserInteractions ?? true,
      trackResources: opts.trackResources ?? true,
      trackLongTasks: opts.trackLongTasks ?? true,
      defaultPrivacyLevel: opts.defaultPrivacyLevel ?? 'mask',
      allowedTracingUrls: opts.allowedTracingUrls,
    });
    initialized = true;
    service = opts.service;
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[rum] init failed', err);
    return false;
  }
}

/**
 * Incrementally merge fields into the RUM user object. Uses setUserProperty so
 * subsequent calls don't clobber earlier ones (the v6 deprecation-free path).
 */
export function setRumUser(patch: RumUserPatch): void {
  if (!initialized) return;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    datadogRum.setUserProperty(key, value);
  }
}

export function clearRumUser(): void {
  if (!initialized) return;
  datadogRum.clearUser();
}

/**
 * Pass-through to `datadogRum.setGlobalContextProperty`. Consumers add their
 * own app-specific context here (e.g. selected_program_ids for saga-dash,
 * doc_id + peer_count for qboard/connectv3).
 */
export function setRumGlobalContextProperty(key: string, value: unknown): void {
  if (!initialized) return;
  datadogRum.setGlobalContextProperty(key, value);
}

/** Tag every error with `source: <service>` so the existing saga_web retention
 *  filter pattern (`@error.source:saga_dash` etc.) works out of the box. The
 *  service tag is applied last so it cannot be overridden by spread context. */
export function addRumError(error: unknown, context?: Record<string, unknown>): void {
  if (!initialized) return;
  datadogRum.addError(error, { ...context, source: service });
}

export function addRumAction(name: string, context?: Record<string, unknown>): void {
  if (!initialized) return;
  datadogRum.addAction(name, { ...context, source: service });
}

/** Whether initRum() has succeeded. */
export function isInitialized(): boolean {
  return initialized;
}

/** Test-only escape hatch — resets module state. Double-underscore prefix
 *  signals "not part of the public API"; consumers should not import this. */
export function __resetForTest(): void {
  initialized = false;
  service = '';
}
