// Deterministic UUIDv5 runId so a same-hour rerun overwrites the same S3 keys.

import { createHash } from 'node:crypto';

// Fixed; changing it changes every runId.
const RUN_ID_NAMESPACE = '3e43ce0a-10df-4666-9555-ecbfd60d3a73';

function uuidv5(namespace: string, name: string): string {
  const namespaceBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1')
    .update(Buffer.concat([namespaceBytes, Buffer.from(name, 'utf8')]))
    .digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** UTC hour bucket, e.g. "2026-09-25T14". */
export function hourBucket(now: Date): string {
  return now.toISOString().slice(0, 13);
}

export function deterministicRunId(namespaceLabel: string, now: Date): string {
  return uuidv5(RUN_ID_NAMESPACE, `${namespaceLabel}:${hourBucket(now)}`);
}
