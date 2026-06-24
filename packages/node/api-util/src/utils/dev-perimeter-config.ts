import { z } from 'zod';

/**
 * Dev recon perimeter config — the OUTER JumpCloud recon gate.
 *
 * This is the **dev-only** perimeter that keeps random visitors from reconning
 * non-production Saga APIs. `@saga-ed/janus-client`'s janusContext +
 * requireAuth({ janus: true }) verify the janus_session cookie against the
 * gate's JWKS ahead of the user-facing routes (health/metrics excepted), in
 * front of the inner IAM-session layer.
 *
 * Topology (the load-bearing distinction this rename makes explicit):
 *   - **dev / preview** (`*.wootdev.com`): perimeter ON — recon protection,
 *     mirrors the deployed app so callers exercise the real two-layer path.
 *   - **prod** (`*.saga.org`): perimeter OFF — prod is END-USER facing and
 *     authenticates via **iam-api only**. JumpCloud gates nothing in prod.
 *   - Staff/JumpCloud authz in prod is a **separate door**, handled outside
 *     this toggle — do NOT read "perimeter off in prod" as "no JumpCloud
 *     anywhere in prod."
 *
 * `DEV_PERIMETER_ENABLED=false` disables the perimeter (the prod posture, and
 * the dev e2e escape hatch). Fail-safe: only the literal string `"false"`
 * disables — a typo'd value keeps the gate ON, so a mis-set env never silently
 * opens a non-prod perimeter. The prod boot guard in
 * {@link assertDevPerimeterProductionConfig} enforces OFF-in-prod on top of
 * this default.
 *
 * Back-compat: the legacy env name `JANUS_REQUIRED` is still read as an alias
 * for one release (deprecation warn). `JANUS_REQUIRED=false` → perimeter off,
 * same as `DEV_PERIMETER_ENABLED=false`.
 *
 * Ported from the byte-/behavior-identical copies previously living in
 * program-hub-service-kit, rostering's iam-api, and qboard's connectv3-api.
 */
export const DevPerimeterConfigSchema = z.object({
  configType: z.literal('DEV_PERIMETER').default('DEV_PERIMETER'),
  /** Whether the dev recon perimeter is enabled. Default ON (dev/preview posture). */
  enabled: z.boolean().default(true),
  // z.string().url() (NOT z.url()): the latter is a zod-4-only top-level API.
  // This package serves zod-3 consumers (program-hub, rostering, qboard), and
  // tsup bundles no zod (skipNodeModulesBundle) — so the consumer's zod runs at
  // runtime. z.string().url() is portable across zod 3 and 4; z.url() would
  // throw at module-eval under a zod-3 consumer.
  jwksUrl: z.string().url().default('https://gate.wootdev.com/.well-known/jwks.json'),
  /** Host used in emitted SagaAuth `login=` URLs (e.g. login.saga.org in prod). */
  loginHost: z.string().optional(),
});

// Plain interface, NOT `z.infer<typeof DevPerimeterConfigSchema>`. An inferred
// type leaks zod-internal types (z.core.$strip) into the published .d.ts, which
// a zod-3 consumer can't resolve — the type then collapses to `unknown` at the
// call site. A hand-written interface keeps the public type surface
// zod-agnostic. `loadDevPerimeterConfig`'s `return DevPerimeterConfigSchema.parse(...)`
// below is the compile-time guard that this interface stays in sync.
export interface DevPerimeterConfig {
  configType: 'DEV_PERIMETER';
  enabled: boolean;
  jwksUrl: string;
  loginHost?: string;
}

/** Deprecated env name → still honored for one release. */
const LEGACY_ENABLED_ENV = 'JANUS_REQUIRED';
const ENABLED_ENV = 'DEV_PERIMETER_ENABLED';

/**
 * Build a {@link DevPerimeterConfig} from environment variables.
 *
 * Reads the deployment-contract names verbatim — `DEV_PERIMETER_ENABLED`,
 * `JANUS_JWKS_URL`, `JANUS_LOGIN_HOST` — the same names the CFN templates
 * inject. The legacy `JANUS_REQUIRED` is honored as a deprecated alias (warns
 * once) when the new name is unset. Unset vars fall through to schema defaults.
 *
 * The `enabled` parse pins the fail-safe invariant: anything other than the
 * literal `"false"` (including a typo or empty string) leaves the perimeter ON.
 */
export function loadDevPerimeterConfig(env: NodeJS.ProcessEnv = process.env): DevPerimeterConfig {
  const input: Record<string, unknown> = {};

  const newVal = env[ENABLED_ENV];
  const legacyVal = env[LEGACY_ENABLED_ENV];
  if (newVal !== undefined) {
    input.enabled = newVal !== 'false';
  } else if (legacyVal !== undefined) {
    // eslint-disable-next-line no-console
    console.warn(
      `[dev-perimeter] ${LEGACY_ENABLED_ENV} is deprecated; rename to ${ENABLED_ENV}. ` +
        'Honoring the legacy value for this release.',
    );
    input.enabled = legacyVal !== 'false';
  }

  if (env.JANUS_JWKS_URL !== undefined) input.jwksUrl = env.JANUS_JWKS_URL;
  if (env.JANUS_LOGIN_HOST !== undefined) input.loginHost = env.JANUS_LOGIN_HOST;
  return DevPerimeterConfigSchema.parse(input);
}

// ---------------------------------------------------------------------------
// Deprecated aliases (removed next major). Keep the old type/loader names
// importable for one release so consumers migrate without a hard break.
// `required` ↔ `enabled` are the same boolean.
// ---------------------------------------------------------------------------
/** @deprecated Use {@link DevPerimeterConfig}. `required` is now `enabled`. */
export interface JanusConfig {
  configType: 'JANUS';
  required: boolean;
  jwksUrl: string;
  loginHost?: string;
}

/** @deprecated Use {@link loadDevPerimeterConfig}. */
export function loadJanusConfig(env: NodeJS.ProcessEnv = process.env): JanusConfig {
  const cfg = loadDevPerimeterConfig(env);
  return {
    configType: 'JANUS',
    required: cfg.enabled,
    jwksUrl: cfg.jwksUrl,
    ...(cfg.loginHost !== undefined ? { loginHost: cfg.loginHost } : {}),
  };
}

/** @deprecated Use {@link DevPerimeterConfigSchema}. */
export const JanusConfigSchema = DevPerimeterConfigSchema;
