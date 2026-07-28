import { CredentialsMethod, OpenFgaClient } from '@openfga/sdk';

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
  /**
   * Preshared key sent as `Authorization: Bearer <token>` (SEC-REQ-5).
   *
   * Required against any OpenFGA running `authn=preshared` — which the SHARED
   * dev and prod servers do (`OPENFGA_AUTHN_METHOD=preshared` on the
   * `openfga-shared-<env>` task definition). Without it every call is a 401,
   * which surfaces as `FgaUnavailableError` — correctly NOT a deny, but the
   * gate answers nothing.
   *
   * Optional so a local/CI OpenFGA started with no authn still works: when
   * unset no credentials are configured and the header is never sent.
   *
   * ⚠️ This makes `FgaGateConfig` SECRET-BEARING. Never `JSON.stringify` or
   * log the config object — enumerate the non-secret fields explicitly
   * (`enforce`/`apiUrl`/`storeId`/`modelId`) as authz-api's bootstrap does.
   */
  apiToken?: string | undefined;
}

export function loadFgaGateConfig(
  env: Record<string, string | undefined> = process.env,
): FgaGateConfig {
  return {
    enforce: env.AUTHZ_FGA_ENFORCE === 'true',
    apiUrl: env.OPENFGA_API_URL ?? 'http://localhost:8080',
    storeId: env.OPENFGA_STORE_ID || undefined,
    modelId: env.OPENFGA_MODEL_ID || undefined,
    apiToken: env.OPENFGA_API_TOKEN || undefined,
  };
}

/**
 * A tuple supplied on the request rather than stored in the graph.
 *
 * Ephemeral objects (a session occurrence, whose id decodes to
 * date/period/slot/pod) are never materialized as stored tuples. The caller
 * resolves the derived facts locally — effective pod after SWAP/ABSENT at NOW,
 * the per-occurrence override host after its live-membership gate — and rides
 * them in on the check. Contextual-tuple relations are marked as such in the
 * partition registry (ADR 0006 §3); they are never ALSO stored.
 */
export interface FgaContextualTuple {
  user: string;
  relation: string;
  object: string;
}

/**
 * Raised when the PDP could not reach a verdict — a transport failure,
 * a non-2xx from OpenFGA, or missing store configuration.
 *
 * This exists to keep "unavailable" separable from "denied" at every call
 * site. A confirmed deny may be masked (e.g. presented as NOT_FOUND); an
 * error must NEVER take that path — it surfaces as the distinct
 * authz-unavailable signal (north star P5). Because `check` returns a bare
 * boolean, a swallowed failure would be indistinguishable from a legitimate
 * `false` and would silently mask an outage as a permission denial.
 */
export class FgaUnavailableError extends Error {
  override readonly name = 'FgaUnavailableError';
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/**
 * The outcome of a `checkDetailed` call: whether access is allowed, and — when
 * it is — which relation branch produced it.
 */
export interface FgaDetailedDecision {
  allowed: boolean;
  /**
   * The first branch (in the order supplied) that held, or `undefined` when
   * none did. Callers map this to their own actor vocabulary, e.g.
   * `'host' → HOST`, `'edit_grant' → ADMIN` (D19 attribution).
   */
  via?: string | undefined;
  /** Every branch that held, in the order supplied. */
  branches: string[];
}

export interface FgaGate {
  /** Call sites skip enforcement entirely when false. */
  readonly enforce: boolean;
  /**
   * True iff (user, relation, object) holds in the configured store/model.
   * Throws {@link FgaUnavailableError} when no verdict could be reached —
   * never returns `false` to mean "could not tell".
   */
  check(
    user: string,
    relation: string,
    object: string,
    contextualTuples?: readonly FgaContextualTuple[],
  ): Promise<boolean>;
  /**
   * Evaluate several relation branches on the same object and report which
   * one(s) held.
   *
   * Attribution is composed from independent Checks rather than read out of a
   * single one: an OpenFGA Check answers only `allowed`, so a union relation
   * (`can_edit: host or edit_grant`) cannot say which side fired. The model
   * therefore keeps the branches separable and we ask each in turn — see the
   * invariant recorded in `unified-graph.fga`'s `session` type.
   *
   * Branches are evaluated in parallel; `via` reports the first one that held
   * in the order supplied, so pass them in attribution-priority order (e.g.
   * `['host', 'edit_grant']` — HOST wins over ADMIN when both hold).
   */
  checkDetailed(
    user: string,
    relations: readonly string[],
    object: string,
    contextualTuples?: readonly FgaContextualTuple[],
  ): Promise<FgaDetailedDecision>;
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
      // Omit `credentials` entirely when no token is configured — passing
      // method `none` and passing nothing are equivalent to the SDK, but an
      // absent key keeps "this deployment has no auth" visible in the shape.
      ...(config.apiToken
        ? {
            credentials: {
              method: CredentialsMethod.ApiToken,
              config: { token: config.apiToken },
            },
          }
        : {}),
    });
    return client;
  };

  const checkOne = async (
    user: string,
    relation: string,
    object: string,
    contextualTuples?: readonly FgaContextualTuple[],
  ): Promise<boolean> => {
    let res;
    try {
      res = await clientFor().check({
        user,
        relation,
        object,
        ...(contextualTuples?.length ? { contextualTuples: [...contextualTuples] } : {}),
      });
    } catch (cause) {
      // Any failure to REACH a verdict — unconfigured store, transport error,
      // non-2xx — is unavailability, not denial. Never collapse it to `false`.
      throw new FgaUnavailableError(
        `FGA check failed for ${relation} on ${object}`,
        { cause },
      );
    }
    return res.allowed === true;
  };

  return {
    enforce: config.enforce,
    check: checkOne,
    async checkDetailed(user, relations, object, contextualTuples) {
      const held = await Promise.all(
        relations.map((relation) => checkOne(user, relation, object, contextualTuples)),
      );
      const branches = relations.filter((_, i) => held[i]);
      return {
        allowed: branches.length > 0,
        via: branches[0],
        branches,
      };
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
 *
 * Two distinct failure modes propagate, and callers must keep them apart:
 * `makeForbidden()` on a confirmed deny, and {@link FgaUnavailableError} when
 * no verdict was reachable. Do not catch them together — masking a deny as
 * NOT_FOUND is correct (D15), masking an outage that way is not.
 */
export async function enforceFgaRelation(
  gate: Pick<FgaGate, 'enforce' | 'check'>,
  user: string,
  relation: string,
  object: string,
  makeForbidden: () => Error,
): Promise<void> {
  if (!gate.enforce) return;
  const allowed = await gate.check(user, relation, object);
  if (!allowed) throw makeForbidden();
}
