/**
 * Data-plane STYLE of a deployed environment (I#375, Phase 2) — PURE.
 *
 * `ss env connect` has to answer one question before it can open a tunnel:
 * once the target database is known, WHERE is it reachable? Live discovery
 * (2026-07-28) showed the two shared accounts answer that differently, and the
 * difference is structural, not incidental:
 *
 *   'db-host-cloudmap' (dev, training) — per-service DB CONTAINERS on a
 *       db-host-v2 fleet, registered in CloudMap under `dbHostNamespace`. The
 *       shared jump host's SG cannot reach the containers, so a tunnel has to
 *       go via the container's OWN EC2 host with a 127.0.0.1 dial.
 *   'rds-endpoint' (prod) — a shared RDS instance. There is no db-host fleet,
 *       no CloudMap namespace, and no SG problem: the jump host forwards
 *       straight to the endpoint, whose address is read at run time from the
 *       SSM parameters named by `postgresEndpointParams`.
 *
 * The style is DERIVED from the registry, never from `env.name`: an env
 * declares its data plane by which fields it carries, so a new account
 * inherits the right routing by declaration. `dbHostNamespace` is the
 * discriminator because its presence is exactly the thing that makes the
 * CloudMap dance necessary.
 */

import type { DeployedEnv } from './registry.js';

export type DataPlaneStyle = 'db-host-cloudmap' | 'rds-endpoint';

/**
 * Which reachability path `env connect` must take for this environment.
 * db-host-v2 fleet present ⇒ the CloudMap route; absent ⇒ the shared-endpoint
 * route (whose endpoint parameters `postgresEndpointParams` names).
 */
export function dataPlaneStyle(env: Pick<DeployedEnv, 'dbHostNamespace'>): DataPlaneStyle {
  return env.dbHostNamespace === undefined ? 'rds-endpoint' : 'db-host-cloudmap';
}
