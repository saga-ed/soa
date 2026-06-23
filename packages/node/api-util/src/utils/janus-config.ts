import { z } from 'zod';

/**
 * Janus perimeter config — the OUTER, all-or-nothing Saga-employee gate.
 *
 * `@saga-ed/janus-client`'s janusContext + requireAuth({ janus: true })
 * verify the janus_session cookie against the gate's JWKS ahead of the
 * user-facing routes (health/metrics excepted). This sits in front of the
 * inner IAM-session layer: the Saga-employee perimeter is satisfied first,
 * then IAM identity resolves in the tRPC context.
 *
 * `JANUS_REQUIRED=false` is the dev-account escape hatch: the middleware
 * short-circuits end-to-end (no JWKS dependency), so the daily e2e
 * composition can drive deployed backends unattended (no interactive
 * JumpCloud session). Fail-safe: only the literal string `"false"`
 * disables — a typo'd value keeps the gate ON, so a mis-set env never
 * silently opens the perimeter. The boot guard in
 * {@link assertJanusProductionConfig} backs this default by refusing
 * `required=false` outside local dev.
 *
 * Ported from the byte-/behavior-identical copies previously living in
 * program-hub-service-kit, rostering's iam-api, and qboard's connectv3-api.
 * Same consolidation as the SagaAuth URL primitives in `saga-auth-url.ts`.
 */
export const JanusConfigSchema = z.object({
  configType: z.literal('JANUS').default('JANUS'),
  required: z.boolean().default(true),
  jwksUrl: z.url().default('https://gate.wootdev.com/.well-known/jwks.json'),
  /** Host used in emitted SagaAuth `login=` URLs (e.g. login.saga.org in prod). */
  loginHost: z.string().optional(),
});
export type JanusConfig = z.infer<typeof JanusConfigSchema>;

/**
 * Build a {@link JanusConfig} from environment variables.
 *
 * Reads the deployment-contract names verbatim — `JANUS_REQUIRED`,
 * `JANUS_JWKS_URL`, `JANUS_LOGIN_HOST` — the same names the CFN templates
 * inject. Unset vars fall through to the schema defaults.
 *
 * The `required` parse pins the fail-safe invariant: anything other than
 * the literal `"false"` (including a typo or empty string) leaves the
 * perimeter ON.
 */
export function loadJanusConfig(env: NodeJS.ProcessEnv = process.env): JanusConfig {
  const input: Record<string, unknown> = {};
  if (env.JANUS_REQUIRED !== undefined) input.required = env.JANUS_REQUIRED !== 'false';
  if (env.JANUS_JWKS_URL !== undefined) input.jwksUrl = env.JANUS_JWKS_URL;
  if (env.JANUS_LOGIN_HOST !== undefined) input.loginHost = env.JANUS_LOGIN_HOST;
  return JanusConfigSchema.parse(input);
}
