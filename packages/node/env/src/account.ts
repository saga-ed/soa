import { EnvIdentityError } from './errors.js';
import type { AccountResolver, FetchLike, ResolvedAccount, Vars } from './types.js';

export const PROD_ACCOUNT_ID = '531314149529';
export const DEV_ACCOUNT_ID = '396913734878';

const LOCAL_FORBIDDEN_VARS = [
  'ECS_CONTAINER_METADATA_URI',
  'ECS_CONTAINER_METADATA_URI_V4',
  'AWS_EXECUTION_ENV',
  'AWS_LAMBDA_FUNCTION_NAME',
] as const;

const DEFAULT_TIMEOUT_MS = 2000;

export interface ResolveAccountOptions {
  /** Defaults to global fetch. Tests inject a stub; nothing here touches the network on its own. */
  fetch?: FetchLike;
  /** ECS metadata request timeout. Default 2000. */
  timeoutMs?: number;
}

/** Maps a 12-digit account id to a kind. Any id other than prod or dev throws (fail closed). */
export function accountFromId(id: string): ResolvedAccount {
  if (id === PROD_ACCOUNT_ID) return { kind: 'prod', id };
  if (id === DEV_ACCOUNT_ID) return { kind: 'dev', id };
  throw new EnvIdentityError(`AWS account ${id} is neither the prod nor the dev account`);
}

function isPresent(vars: Vars, name: string): boolean {
  return vars[name] !== undefined;
}

async function accountFromEcs(
  metadataUri: string,
  fetchImpl: FetchLike,
  timeoutMs: number
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${metadataUri}/task`, { signal: controller.signal });
    if (!res.ok) throw new Error(`ECS task metadata returned HTTP ${res.status}`);
    const body = (await res.json()) as { TaskARN?: unknown };
    const arn = typeof body?.TaskARN === 'string' ? body.TaskARN : '';
    const parts = arn.split(':');
    const id = parts[4];
    if (parts[0] !== 'arn' || id === undefined || !/^\d{12}$/.test(id)) {
      throw new Error('ECS task metadata has no parseable TaskARN');
    }
    return id;
  } finally {
    clearTimeout(timer);
  }
}

async function accountFromResolver(resolver: AccountResolver): Promise<string | undefined> {
  const id = await resolver();
  if (id === undefined) return undefined;
  if (!/^\d{12}$/.test(id)) throw new Error('resolver returned a malformed account id');
  return id;
}

/**
 * ECS task metadata (`ECS_CONTAINER_METADATA_URI_V4`), then the injected resolver. Throws when the
 * account cannot be resolved or is not prod/dev; never defaults.
 *
 * `SAGA_LOCAL=1` yields kind `local`. It is refused (throws) when ECS_CONTAINER_METADATA_URI(_V4),
 * AWS_EXECUTION_ENV or AWS_LAMBDA_FUNCTION_NAME is present, or when the resolver positively returns
 * the prod account. Under `SAGA_LOCAL=1` any other resolver outcome (failure, no result, a non-prod
 * account) resolves to `local`.
 */
export async function resolveAccount(
  vars: Vars,
  resolver?: AccountResolver,
  options: ResolveAccountOptions = {}
): Promise<ResolvedAccount> {
  if (vars['SAGA_LOCAL'] === '1') {
    const present = LOCAL_FORBIDDEN_VARS.filter(name => isPresent(vars, name));
    if (present.length > 0) {
      throw new EnvIdentityError(
        `SAGA_LOCAL=1 refused: deployed-runtime signal present (${present.join(', ')})`
      );
    }
    if (resolver) {
      let id: string | undefined;
      try {
        id = await accountFromResolver(resolver);
      } catch {
        id = undefined;
      }
      if (id === PROD_ACCOUNT_ID) {
        throw new EnvIdentityError('SAGA_LOCAL=1 refused: credentials resolve to the prod account');
      }
    }
    return { kind: 'local' };
  }

  const failures: string[] = [];
  const metadataUri = vars['ECS_CONTAINER_METADATA_URI_V4'];
  if (metadataUri) {
    const fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
    if (!fetchImpl) {
      failures.push('ECS metadata lookup: no fetch implementation available');
    } else {
      try {
        return accountFromId(
          await accountFromEcs(metadataUri, fetchImpl, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
        );
      } catch (err) {
        if (err instanceof EnvIdentityError) throw err;
        failures.push(`ECS metadata lookup failed: ${(err as Error).message}`);
      }
    }
  }
  if (resolver) {
    try {
      const id = await accountFromResolver(resolver);
      if (id !== undefined) return accountFromId(id);
      failures.push('account resolver returned no account');
    } catch (err) {
      if (err instanceof EnvIdentityError) throw err;
      failures.push(`account resolver failed: ${(err as Error).message}`);
    }
  }
  throw new EnvIdentityError(
    `AWS account could not be resolved (set SAGA_LOCAL=1 only for local runs)${
      failures.length ? `: ${failures.join('; ')}` : ''
    }`
  );
}
