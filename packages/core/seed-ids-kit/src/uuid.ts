/**
 * UUID constructors for the fleet, built on `@noble/hashes` (audited,
 * zero-dependency, isomorphic) so the same code runs in Node and the browser:
 *
 *   - `uuidv5` — name-based, DETERMINISTIC. Same input -> same id, with no
 *     coordination. This is what the `*-seed-ids` contract is built on.
 *   - `uuidv7` — time-ordered, NON-deterministic. For runtime-generated primary
 *     keys (DB index locality), NOT for seed ids.
 */
// `sha1` is flagged @deprecated by @noble/hashes as security guidance — but
// RFC 4122 v5 UUIDs are *defined* on SHA-1, so this is a correct, non-security use.
import { sha1 } from '@noble/hashes/sha1';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils';

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

/**
 * RFC 9562 v7 UUID — time-ordered (48-bit Unix-ms timestamp + random bits).
 *
 * Use for **runtime-generated primary keys**, where time-ordering improves
 * database index/B-tree locality vs random v4. **Not** for the `*-seed-ids`
 * contract: v7 has no name input, so it is non-deterministic — independent
 * services cannot reproduce the same id. Use `uuidv5` / the derivers for that.
 *
 * Ordering is millisecond-granular; ids minted in the same millisecond carry
 * independent random bits and are not mutually ordered. `timestamp` defaults to
 * now and is exposed only for testing / backfill.
 */
export function uuidv7(timestamp: number = Date.now()): string {
  const b = Array.from(randomBytes(16));
  // 48-bit big-endian millisecond timestamp in bytes 0..5 (division avoids the
  // 32-bit truncation a bitwise mask would hit on values above 2^32).
  let t = Math.floor(timestamp);
  for (let i = 5; i >= 0; i--) {
    b[i] = t % 256;
    t = Math.floor(t / 256);
  }
  const at = (i: number): number => b[i] ?? 0; // 16 bytes: always defined
  b[6] = (at(6) & 0x0f) | 0x70; // version 7
  b[8] = (at(8) & 0x3f) | 0x80; // RFC 4122 variant
  const h = bytesToHex(Uint8Array.from(b));
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
