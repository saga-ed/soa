/**
 * Mesh infra units — container names, host ports, and readiness probes.
 *
 * Verified against plan §2.2 "Mesh" table and up.sh's mesh wiring. The mesh is
 * started as a single unit (`make up PROFILE=empty`); these defs drive the
 * `check_ports` host-port preflight (review major) and per-unit readiness gating
 * in the mesh-up runtime adapter (M1+). Container names are overridable via env
 * in the runtime layer (e.g. SAGA_MESH_POSTGRES_CONTAINER); the defaults here are
 * the compose-default names.
 */

import type { MeshDef, MeshId } from './types.js';

export const MESH: Readonly<Record<MeshId, MeshDef>> = {
  postgres: {
    id: 'postgres',
    container: 'soa-postgres-1',
    port: 5432,
    readinessCmd: 'pg_isready -U postgres_admin',
    timeoutSec: 20,
  },
  redis: {
    id: 'redis',
    container: 'soa-redis-1',
    port: 6379,
    readinessCmd: 'redis-cli ping', // → PONG
    timeoutSec: 20,
  },
  rabbitmq: {
    id: 'rabbitmq',
    container: 'soa-rabbitmq-1',
    port: 5672,
    mgmtPort: 15672,
    readinessCmd: 'rabbitmq-diagnostics -q ping',
    timeoutSec: 45, // slowest cold boot
  },
  'connect-mongo': {
    id: 'connect-mongo',
    container: 'soa-connect-mongo-1',
    port: 27037,
    readinessCmd: "mongosh --eval 'db.runCommand({ping:1}).ok'",
    timeoutSec: 20,
  },
  openfga: {
    id: 'openfga',
    container: 'soa-openfga-1',
    port: 8080, // HTTP API
    mgmtPort: 8081, // gRPC (used for the health probe, not an HTTP mgmt UI)
    readinessCmd: '/usr/local/bin/grpc_health_probe -addr=:8081',
    // openfga/openfga is a distroless-style image with no `sh` — `docker exec
    // ... sh -c '<cmd>'` fails with "sh: executable file not found" before the
    // probe even runs. shell:false execs the probe binary directly.
    shell: false,
    // Only brought up when the `authz` bundle is selected (--with authz); the
    // one-shot `openfga_migrate` sidecar (infra/compose/services/openfga/compose.yml)
    // isn't modeled as its own MeshId — compose's own service_completed_successfully
    // dependency already gates `openfga`'s start on it.
    timeoutSec: 30,
  },
};
