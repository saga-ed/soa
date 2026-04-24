/**
 * Shared lookup helpers for iam:* and pgm:* commands.
 *
 * Every object authored by the CLI is stamped with source=<source> +
 * sourceId=<slug> so we can redirect slug references back to UUIDs across
 * separate CLI invocations. These helpers wrap the two primary lookup paths:
 *
 *   findGroupBySourceId — groups.findBySourceBulk (returns null if absent)
 *   findUserByUsername  — users.search (returns null if absent)
 *   resolveGroupId      — accept slug or UUID, throw if slug is unknown
 */

import type { TrpcClient } from './lib/http.js';

export interface Group {
  id: string;
  kind: string;
  displayName: string | null;
  source: string | null;
  sourceId: string | null;
}

export interface User {
  id: string;
  username: string;
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

export async function findUserByUsername(
  iamClient: TrpcClient,
  username: string,
): Promise<User | null> {
  const result = await iamClient.query<{ items: User[]; total: number }>(
    'users.search',
    { username, limit: 1 },
  );
  return result.items.find((u) => u.username === username) ?? null;
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
