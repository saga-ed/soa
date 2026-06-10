import type { InspectGates } from './wire.js';

export interface InspectEnv {
    token: string | undefined;
    gates: InspectGates;
}

/**
 * Standard env surface, shared fleet-wide so sandbox deploy workflows can
 * inject one uniform trio per service:
 *
 *   INSPECT_TOKEN            — static bearer (unset ⇒ surface is dark)
 *   ALLOW_INSPECT_ENTITIES   — 'true' to enable entity browsing (PII-bearing)
 *   ALLOW_INSPECT_STATUS     — 'true' to enable projection-status reporting
 *
 * Naming follows the iam-api admin-gate convention (ALLOW_* + *_TOKEN).
 */
export function loadInspectEnv(env: NodeJS.ProcessEnv = process.env): InspectEnv {
    const bool = (value: string | undefined): boolean => value?.toLowerCase() === 'true';
    return {
        token: env.INSPECT_TOKEN,
        gates: {
            entities: bool(env.ALLOW_INSPECT_ENTITIES),
            status: bool(env.ALLOW_INSPECT_STATUS),
        },
    };
}
