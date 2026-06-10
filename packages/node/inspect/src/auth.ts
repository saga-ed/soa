import { createHash, timingSafeEqual } from 'node:crypto';

const BEARER_PREFIX = 'Bearer ';

/**
 * Constant-time bearer compare (same construction as iam-api's admin gates).
 * Hashes both sides with SHA-256 first so inputs are always the same length —
 * `timingSafeEqual` throws on length mismatch, which is itself a side-channel.
 */
export function tokensMatch(submitted: string, expected: string): boolean {
    const a = createHash('sha256').update(submitted).digest();
    const b = createHash('sha256').update(expected).digest();
    return timingSafeEqual(a, b);
}

/** Extracts the token from an `Authorization: Bearer …` header, else null. */
export function bearerToken(authorizationHeader: string | undefined): string | null {
    if (!authorizationHeader?.startsWith(BEARER_PREFIX)) return null;
    const token = authorizationHeader.slice(BEARER_PREFIX.length);
    return token.length > 0 ? token : null;
}
