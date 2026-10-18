import type { ProbeOutcome } from './deep/types.js';

/**
 * AWS has NO default probe. Pass the cheapest operation the task role ALREADY performs in normal
 * operation (JWKS GetPublicKey, GetParameter on a parameter the app reads, a key the app reads).
 * DescribeKey/HeadBucket are not defaults: the role may not hold them, which would be a permanent 503.
 * Wrapper only; the app's own SDK client is passed through, with no @aws-sdk dependency here.
 */
export function awsProbe<C>(
  operation: (client: C, signal: AbortSignal) => Promise<unknown>,
): (client: C, signal: AbortSignal) => Promise<ProbeOutcome> {
  return async (client, signal) => {
    await operation(client, signal);
    return { ok: true };
  };
}
