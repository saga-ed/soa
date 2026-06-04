/**
 * Browser-safe deterministic UUIDs for the `*-seed-ids` contract.
 *
 * Uses `@noble/hashes` (audited, zero-dependency, isomorphic) instead of
 * `node:crypto`, so the same function runs in Node seed scripts AND in browser
 * bundles (saga-dash, janus) with byte-identical output. That removes the only
 * reason the original `iam-seed-ids` had to pre-freeze its ids into a committed
 * `ids.ts`: with a browser-safe hash, every consumer can compute on demand.
 */
// `sha1` is flagged @deprecated by @noble/hashes as security guidance — but
// RFC 4122 v5 UUIDs are *defined* on SHA-1, so this is a correct, non-security use.
import { sha1 } from '@noble/hashes/sha1';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

const encoder = new TextEncoder();

/**
 * RFC 4122 v5 (SHA-1) UUID — `uuidv5(name, namespace)`.
 *
 * Byte-identical to a `node:crypto` v5 implementation (SHA-1 is
 * implementation-independent), so adopting this changes no existing id. The
 * `namespace` is a UUID string; `name` is any stable key (e.g. `group:lincoln`).
 */
export function uuidv5(name: string, namespace: string): string {
  const ns = hexToBytes(namespace.replace(/-/g, ''));
  const nameBytes = encoder.encode(name);
  const input = new Uint8Array(ns.length + nameBytes.length);
  input.set(ns);
  input.set(nameBytes, ns.length);
  const b = Array.from(sha1(input).subarray(0, 16));
  const at = (i: number): number => b[i] ?? 0; // 16-byte digest: always defined
  b[6] = (at(6) & 0x0f) | 0x50; // version 5
  b[8] = (at(8) & 0x3f) | 0x80; // RFC 4122 variant
  const h = bytesToHex(Uint8Array.from(b));
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
