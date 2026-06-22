import { OpenFgaClient } from '@openfga/sdk';

/**
 * @saga-ed/saga-fga — Tier-2 (per-resource) OpenFGA authorization gate.
 *
 * A thin `check` client over `@openfga/sdk` plus an enforcement flag and a
 * framework-agnostic helper. Application services use this to answer
 * "can user X do action A on object R?" — they NEVER write tuples (ADR 0005);
 * writes flow through the sync worker.
 *
 * Enforcement is OFF by default (`AUTHZ_FGA_ENFORCE !== 'true'`) so adopting
 * the gate is non-breaking: existing service-level checks remain authoritative
 * until the flag is flipped on.
 */

export interface FgaGateConfig {
  /** Master switch. When false, `enforceFgaRelation` is a no-op (never checks). */
  enforce: boolean;
  /** OpenFGA HTTP API base, e.g. http://localhost:8080. */
  apiUrl: string;
  /** Store id (minted by the model bootstrap); required before any check runs. */
  storeId?: string | undefined;
  /** Authorization model id; when unset OpenFGA uses the store's latest. */
  modelId?: string | undefined;
}

export function loadFgaGateConfig(
  env: Record<string, string | undefined> = process.env,
): FgaGateConfig {
  return {
    enforce: env.AUTHZ_FGA_ENFORCE === 'true',
    apiUrl: env.OPENFGA_API_URL ?? 'http://localhost:8080',
    storeId: env.OPENFGA_STORE_ID || undefined,
    modelId: env.OPENFGA_MODEL_ID || undefined,
  };
}

export interface FgaGate {
  /** Call sites skip enforcement entirely when false. */
  readonly enforce: boolean;
  /** True iff (user, relation, object) holds in the configured store/model. */
  check(user: string, relation: string, object: string): Promise<boolean>;
}

/**
 * Build a gate from config. The OpenFGA client is created lazily on first
 * `check`, so a disabled gate (enforce=false, no storeId) never constructs a
 * client and never reaches the network.
 */
export function createFgaGate(config: FgaGateConfig = loadFgaGateConfig()): FgaGate {
  let client: OpenFgaClient | undefined;
  const clientFor = (): OpenFgaClient => {
    if (!config.storeId) {
      throw new Error('FGA check requested but OPENFGA_STORE_ID is not configured');
    }
    client ??= new OpenFgaClient({
      apiUrl: config.apiUrl,
      storeId: config.storeId,
      ...(config.modelId ? { authorizationModelId: config.modelId } : {}),
    });
    return client;
  };

  return {
    enforce: config.enforce,
    async check(user, relation, object) {
      const res = await clientFor().check({ user, relation, object });
      return res.allowed === true;
    },
  };
}

/**
 * Framework-agnostic enforcement. No-op when the gate is disabled; otherwise
 * throws `makeForbidden()` unless the relation holds. Services adapt this into
 * their own error type (e.g. a tRPC `FORBIDDEN`) without coupling this package
 * to a web framework:
 *
 *   await enforceFgaRelation(ctx.fga, `user:${userId}`, 'host', `session:${id}`,
 *     () => new TRPCError({ code: 'FORBIDDEN', message: '...' }));
 */
export async function enforceFgaRelation(
  gate: FgaGate,
  user: string,
  relation: string,
  object: string,
  makeForbidden: () => Error,
): Promise<void> {
  if (!gate.enforce) return;
  const allowed = await gate.check(user, relation, object);
  if (!allowed) throw makeForbidden();
}
