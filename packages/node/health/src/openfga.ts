import type { ProbeOutcome } from './deep/types.js';

/** Structural subset of the OpenFGA SDK client; no hard dependency on `@openfga/sdk`. */
export interface OpenFgaClientLike {
  readLatestAuthorizationModel?(options?: { signal?: AbortSignal }): Promise<{ authorization_model?: unknown }>;
  readAuthorizationModels?(options?: { signal?: AbortSignal }): Promise<unknown>;
}

/** Default openfga probe: read the latest authorization model through the app's own SDK client. */
export async function openfgaProbe(client: OpenFgaClientLike, signal: AbortSignal): Promise<ProbeOutcome> {
  if (client.readLatestAuthorizationModel) {
    const res = await client.readLatestAuthorizationModel({ signal });
    return res?.authorization_model ? { ok: true } : { ok: false, reason: 'unexpected_response' };
  }
  if (client.readAuthorizationModels) {
    await client.readAuthorizationModels({ signal });
    return { ok: true };
  }
  throw new TypeError('openfga client exposes neither readLatestAuthorizationModel nor readAuthorizationModels');
}
