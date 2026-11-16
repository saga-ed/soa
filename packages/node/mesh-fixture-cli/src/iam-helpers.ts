/**
 * Shared lookup helpers for iam:* and pgm:* commands.
 *
 * Every object authored by the CLI is stamped with source=<source> +
 * sourceId=<slug> so we can redirect slug references back to UUIDs across
 * separate CLI invocations. These helpers wrap the two primary lookup paths:
 *
 *   findGroupBySourceId — groups.findBySourceBulk (returns null if absent)
 *   findUserIdByEmail   — auth.devLogin (returns null if absent)
 *   resolveGroupId      — accept slug or UUID, throw if slug is unknown
 */

import { TrpcCallError, type TrpcClient } from './lib/http.js';

export interface Group {
  id: string;
  kind: string;
  displayName: string | null;
  source: string | null;
  sourceId: string | null;
}

export interface User {
  id: string;
}

const UUID_PREFIX_RE = /^[0-9a-f]{8}-/;

export function looksLikeUuid(s: string): boolean {
  return UUID_PREFIX_RE.test(s);
}

export async function findGroupBySourceId(
  iamClient: TrpcClient,
  source: string,
  sourceId: string,
): Promise<Group | null> {
  const groups = await iamClient.query<Group[]>('groups.findBySourceBulk', {
    source,
    sourceIds: [sourceId],
  });
  return groups.find((g) => g.sourceId === sourceId) ?? null;
}

/**
 * The id of the user with this email, or null when there is none.
 *
 * IAM `username` is retired and dropped (rostering
 * docs/iam/identity_fields_cleanup.md), so users are found by email. Email
 * lives encrypted in iam-pii and `users.search` cannot match it;
 * `users.resolveIdsByEmail` needs the `can_view_user_pii` staff capability,
 * which a local stack does not grant. `auth.devLogin` looks the email up by
 * its hash and returns the id, so this works wherever dev login is enabled
 * (local / dev stacks — where this CLI runs) and throws FORBIDDEN elsewhere.
 * Side effect: each lookup mints a throwaway session and a dev-login audit row.
 * An unknown (or inactive) email is UNAUTHORIZED, which reads as "absent".
 */
export async function findUserIdByEmail(
  iamClient: TrpcClient,
  email: string,
): Promise<string | null> {
  try {
    const res = await iamClient.mutation<{ userId: string }>('auth.devLogin', {
      identifier: email,
    });
    return res.userId;
  } catch (err) {
    if (err instanceof TrpcCallError && err.trpcError?.data?.code === 'UNAUTHORIZED') {
      return null;
    }
    throw err;
  }
}

export async function resolveGroupId(
  iamClient: TrpcClient,
  source: string,
  sourceIdOrUuid: string,
): Promise<string> {
  if (looksLikeUuid(sourceIdOrUuid)) return sourceIdOrUuid;
  const group = await findGroupBySourceId(iamClient, source, sourceIdOrUuid);
  if (!group) {
    throw new Error(
      `group with source='${source}' sourceId='${sourceIdOrUuid}' not found (have you run iam:create-org?)`,
    );
  }
  return group.id;
}
