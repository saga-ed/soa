import { CredentialsMethod, OpenFgaClient } from '@openfga/sdk';

/**
 * @saga-ed/saga-fga — Tier-2 (per-resource) OpenFGA authorization gate.
 *
 * A thin `check` client over `@openfga/sdk` plus an enforcement flag and a
 * framework-agnostic helper. Application services use this to answer
 * "can user X do action A on object R?" — they NEVER write tuples (ADR 0005);
 * writes flow through the sync worker.
 *
 * Three query shapes, and the choice matters:
 *   - `check`/`checkDetailed` — one object. Enforcement.
 *   - `batchCheck` — many objects. **Authorization-filtered lists**: fetch the
 *     candidates, then ask about them. Deliberately NOT `ListObjects`, which
 *     cannot report truncation (see `batchCheck`'s doc comment).
 *   - `listUsersDiagnostic` — the reverse question ("WHO holds R on O"), for
 *     debugging and audit tooling ONLY ({@link FgaDiagnostics}; rationale →
 *     README "The reverse question").
 *
 * Enumeration (`ListObjects`) is intentionally absent. If a caller ever truly
 * needs the id set before touching its own datastore, that belongs behind the
 * PDP's own API with an explicit `truncated` contract — not here, where the
 * shape invites silent under-reporting.
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
  // core-tier package: `process` may not exist in the importing runtime.
  env: Record<string, string | undefined> = typeof process === 'undefined' ? {} : process.env
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
 * One (user, relation, object) question in a {@link FgaGate.batchCheck} call.
 *
 * Deliberately the same shape as {@link FgaContextualTuple} but a distinct type:
 * a contextual tuple is an ASSERTED fact riding in on a request, this is a
 * QUESTION being asked. Conflating them reads badly at call sites.
 */
export interface FgaBatchCheckItem {
  user: string;
  relation: string;
  object: string;
}

/**
 * The verdicts from a {@link FgaGate.batchCheck} call, keyed by
 * `${user}|${relation}|${object}` — the natural identity of the question.
 *
 * Use {@link fgaBatchKey} to build a lookup key rather than formatting it by
 * hand. Absence of a key means NO VERDICT was reached for that item, never
 * "denied" — but `batchCheck` throws rather than returning a partial map, so a
 * successfully returned map always holds exactly one entry per requested item
 * (duplicates in the request collapse to one entry).
 */
export type FgaBatchCheckResult = ReadonlyMap<string, boolean>;

/**
 * The lookup key for a {@link FgaBatchCheckResult} entry.
 *
 * NOT the wire `correlation_id`: OpenFGA restricts that to letters, numbers and
 * hyphens with length ≤ 36 (`BatchCheckItem.correlation_id`), which a
 * `user:<uuid>`/`staff_org:<uuid>` triple violates on both counts. The wire ids
 * are therefore opaque generated indices, mapped back to these keys internally.
 */
export function fgaBatchKey(user: string, relation: string, object: string): string {
  return `${user}|${relation}|${object}`;
}

/**
 * The subjects holding a relation, from
 * {@link FgaDiagnostics.listUsersDiagnostic}, partitioned by subject kind:
 *
 *   - `users` — direct subjects (`user:<id>`).
 *   - `usersets` — indirect subjects (`group:<id>#member`); references, not
 *     enumerations — their members are not listed here.
 *   - `wildcardTypes` — object types with a public-wildcard tuple on this
 *     relation (`user:*` → `['user']`).
 *
 * Reading these honestly (userset expansion, wildcard-on-marker semantics) →
 * README "The reverse question".
 */
export interface FgaUserListing {
  users: string[];
  usersets: string[];
  wildcardTypes: string[];
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
    contextualTuples?: readonly FgaContextualTuple[]
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
    contextualTuples?: readonly FgaContextualTuple[]
  ): Promise<FgaDetailedDecision>;
  /**
   * Evaluate many independent (user, relation, object) questions in one call.
   *
   * **This is the fleet's primitive for authorization-FILTERED LISTS** — fetch
   * the candidate records, then ask about them. Prefer it over OpenFGA's
   * `ListObjects` for that job, for two measured reasons:
   *
   * 1. `ListObjectsResponse` is `{ objects: string[] }` — no continuation token,
   *    no truncation flag. It is bounded server-side by a max-results cap and a
   *    deadline, so a CAPPED list and a COMPLETE list are the same response.
   *    Silent under-reporting of a list is an authorization CORRECTNESS bug
   *    (items the user may see never render, with no error), not a perf nit.
   * 2. Result count is not the cost driver: measured p50 was 28ms for ~421
   *    objects vs **73ms for one** — latency tracks graph-search shape. And
   *    list-objects is cache-immune, while `check` goes ~23ms → ~1.4ms warm.
   *    Every sub-check here is check-cache-eligible.
   *
   * Requests are auto-chunked (50 per batch, 10 batches in parallel), so a
   * caller may pass more than 50 items — but each chunk is a round trip, so
   * bound the candidate set rather than passing an unbounded page.
   *
   * Throws {@link FgaUnavailableError} if ANY item failed to reach a verdict —
   * per-item errors are never collapsed to `false`, matching `check`. Returns a
   * map keyed by {@link fgaBatchKey}; duplicate questions collapse to one entry.
   */
  batchCheck(checks: readonly FgaBatchCheckItem[]): Promise<FgaBatchCheckResult>;
}

/**
 * Debug-tier query surface, deliberately separate from {@link FgaGate}:
 * enforcement call sites (and their hand-rolled `FgaGate` test fakes) never
 * carry a diagnostic member. {@link createFgaGate} returns both.
 */
export interface FgaDiagnostics {
  /**
   * The reverse question — "WHO holds `relation` on `object`?" — completing the
   * two-of-three (user, relation, object) debugging triple. **Diagnostic tier
   * ONLY**, and the name is the guardrail: `ListUsers` cannot report truncation
   * (the same defect that keeps `ListObjects` out of this package), so it is
   * never an enforcement input, a notification/fan-out source, or an
   * audit-of-record. Rationale → README "The reverse question".
   *
   * `userTypes` names the subject shapes to search, and the listing contains
   * ONLY what it names: entries map to server-side filters, so the parameter is
   * required — an implicit default would silently hide the shapes it omits
   * (e.g. group grants). `'group#member'` asks for usersets of that shape; bare
   * `'user'` asks for direct subjects.
   *
   * Throws `TypeError` on a malformed argument — a caller bug, detected
   * locally, deliberately NOT {@link FgaUnavailableError} so it can never read
   * as a PDP outage. Throws {@link FgaUnavailableError} when no verdict could
   * be reached, like every other method here — a diagnostic that silently
   * returns `[]` on an outage would send the debugger chasing a phantom
   * missing-tuple bug.
   */
  listUsersDiagnostic(
    relation: string,
    object: string,
    userTypes: readonly string[]
  ): Promise<FgaUserListing>;
}

/**
 * Build a gate from config. The OpenFGA client is created lazily on first
 * `check`, so a disabled gate (enforce=false, no storeId) never constructs a
 * client and never reaches the network.
 */
export function createFgaGate(
  config: FgaGateConfig = loadFgaGateConfig()
): FgaGate & FgaDiagnostics {
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
    contextualTuples?: readonly FgaContextualTuple[]
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
      throw new FgaUnavailableError(`FGA check failed for ${relation} on ${object}`, { cause });
    }
    return res.allowed === true;
  };

  const batchCheck = async (checks: readonly FgaBatchCheckItem[]): Promise<FgaBatchCheckResult> => {
    const verdicts = new Map<string, boolean>();
    if (checks.length === 0) return verdicts;

    // Wire correlation ids are opaque indices: OpenFGA caps correlation_id at 36
    // chars of [A-Za-z0-9-], which our `user:<uuid>`/`<type>:<uuid>` triples blow
    // past. Map them back to natural keys ourselves.
    const keyByCorrelationId = new Map<string, string>();
    const items = checks.map((c, i) => {
      const correlationId = `c${i}`;
      keyByCorrelationId.set(correlationId, fgaBatchKey(c.user, c.relation, c.object));
      return { user: c.user, relation: c.relation, object: c.object, correlationId };
    });

    let res;
    try {
      res = await clientFor().batchCheck({ checks: items });
    } catch (cause) {
      throw new FgaUnavailableError(`FGA batchCheck failed for ${checks.length} item(s)`, {
        cause,
      });
    }

    for (const single of res.result) {
      // A per-item `error` means this question reached no verdict. Surfacing it
      // as `allowed: false` would be a silent deny — the exact failure mode
      // `check`'s contract exists to prevent.
      if (single.error) {
        throw new FgaUnavailableError(
          `FGA batchCheck item failed for ${single.request.relation} on ${single.request.object}`,
          { cause: single.error }
        );
      }
      const key = keyByCorrelationId.get(single.correlationId);
      // An unrecognized correlation id means we cannot attribute this verdict to
      // a question we asked; treating it as anything would be a guess.
      if (key === undefined) {
        throw new FgaUnavailableError(
          `FGA batchCheck returned an unrecognized correlationId: ${single.correlationId}`
        );
      }
      verdicts.set(key, single.allowed === true);
    }

    // Every question must come back answered. A short response is unavailability,
    // not a set of denials.
    const expected = new Set(keyByCorrelationId.values());
    if (verdicts.size !== expected.size) {
      throw new FgaUnavailableError(
        `FGA batchCheck returned ${verdicts.size} verdict(s) for ${expected.size} distinct item(s)`
      );
    }
    return verdicts;
  };

  const listUsersDiagnostic = async (
    relation: string,
    object: string,
    userTypes: readonly string[]
  ): Promise<FgaUserListing> => {
    // Malformed arguments are caller bugs → TypeError, never FgaUnavailableError:
    // a deterministic local rejection must not read as a PDP outage.
    // 'type:id' → the wire's structured object. Split on the FIRST colon only —
    // instance ids may themselves contain separators (session_instance:S|date).
    const sep = object.indexOf(':');
    if (sep <= 0) {
      throw new TypeError(
        `FGA listUsers requires an object of the form "type:id", got "${object}"`
      );
    }
    if (userTypes.length === 0) {
      throw new TypeError('FGA listUsers requires at least one subject-type filter');
    }
    // 'group#member' asks for usersets of that shape; bare 'user' asks for
    // direct subjects.
    const userFilters = userTypes.map(t => {
      if (!/^[^\s#:]+(?:#[^\s#:]+)?$/.test(t)) {
        throw new TypeError(`FGA listUsers filter must be "type" or "type#relation", got "${t}"`);
      }
      const hash = t.indexOf('#');
      return hash > 0 ? { type: t.slice(0, hash), relation: t.slice(hash + 1) } : { type: t };
    });
    let res;
    try {
      res = await clientFor().listUsers({
        object: { type: object.slice(0, sep), id: object.slice(sep + 1) },
        relation,
        user_filters: userFilters,
      });
    } catch (cause) {
      // An outage must never present as an empty listing — the debugger would
      // chase a phantom missing-tuple bug. Same contract as check/batchCheck.
      throw new FgaUnavailableError(`FGA listUsers failed for ${relation} on ${object}`, { cause });
    }
    // A 2xx whose body carries no `users` array reached no verdict — it must
    // not read as an empty listing.
    if (!Array.isArray(res.users)) {
      throw new FgaUnavailableError(
        `FGA listUsers returned a malformed response for ${relation} on ${object}`
      );
    }
    const listing: FgaUserListing = { users: [], usersets: [], wildcardTypes: [] };
    for (const u of res.users) {
      if (u.object) listing.users.push(`${u.object.type}:${u.object.id}`);
      else if (u.userset)
        listing.usersets.push(`${u.userset.type}:${u.userset.id}#${u.userset.relation}`);
      else if (u.wildcard) listing.wildcardTypes.push(u.wildcard.type);
      else {
        // An entry of an unrecognized kind cannot be partitioned; skipping it
        // would silently under-report the listing.
        throw new FgaUnavailableError(
          `FGA listUsers returned an unrecognized subject entry for ${relation} on ${object}`
        );
      }
    }
    return listing;
  };

  return {
    enforce: config.enforce,
    check: checkOne,
    batchCheck,
    listUsersDiagnostic,
    async checkDetailed(user, relations, object, contextualTuples) {
      const held = await Promise.all(
        relations.map(relation => checkOne(user, relation, object, contextualTuples))
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
  makeForbidden: () => Error
): Promise<void> {
  if (!gate.enforce) return;
  const allowed = await gate.check(user, relation, object);
  if (!allowed) throw makeForbidden();
}
