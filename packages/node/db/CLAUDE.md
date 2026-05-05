# db

MongoDB connection management and database utilities.

## Responsibilities

- MongoDB client lifecycle management (connect/disconnect)
- Connection string building (single-host or replica-set, with optional TLS + SCRAM)
- AWS-aware config loader for staging / prod / dev-mirror (reads SSM + Secrets Manager)
- Inversify DI integration for database clients
- Mock MongoDB provider for testing (mongodb-memory-server)
- Zod-validated database configuration
- Future: MySQL and Redis connection managers (stubs present)

## Parent Context

See [/packages/node/CLAUDE.md](../CLAUDE.md) for Node.js package patterns.

## Tech Stack

- **Database**: MongoDB (native driver)
- **DI**: Inversify
- **Validation**: Zod
- **AWS**: `@aws-sdk/client-ssm`, `@aws-sdk/client-secrets-manager`
- **Testing**: mongodb-memory-server, aws-sdk-client-mock
- **Build**: tsup → ESM

## Structure

```
src/
├── index.ts                      # Main exports
├── mongo-provider.ts             # MongoDB connection manager
├── mongo-provider-config.ts      # Zod config schema
├── aws-mongo-loader.ts           # SSM + Secrets Manager → MongoProviderConfig
├── i-mongo-conn-mgr.ts           # Connection manager interface
├── mocks/
│   └── mock-mongo-provider.ts    # In-memory MongoDB for tests
├── redis.ts                      # Placeholder for Redis
└── sql.ts                        # Placeholder for MySQL
```

## Key Exports

```typescript
import { MongoProvider, MongoProviderSchema, loadMongoConfigFromAws } from '@saga-ed/soa-db';
import type { MongoProviderConfig, IMongoConnMgr, LoadMongoConfigParams } from '@saga-ed/soa-db';
import { MONGO_CLIENT, MONGO_CLIENT_FACTORY } from '@saga-ed/soa-db';
import { MockMongoProvider } from '@saga-ed/soa-db/mocks/mock-mongo-provider';
```

## Usage

### Dev — local docker mongo (no TLS, no auth)

For services running against a per-service mongo on `db-host` (port-isolated Docker container; see `cloudformation_templates/dbs/db_host/` in iac), construct config directly:

```typescript
const mongoConfig: MongoProviderConfig = {
  configType: 'MONGO',
  instanceName: 'main',
  hosts: ['ip-10-0-1-1.us-west-2.compute.internal:27018'],
  database: 'coach_db',
};

const provider = new MongoProvider(mongoConfig);
await provider.connect();
container.bind(MONGO_CLIENT).toConstantValue(provider.getClient());
```

Username/password aren't required when the local container runs without `--auth`. The dev `dev-auth-mongo` testbed (see `cloudformation_templates/dbs/db_host/dev-auth-mongo/`) DOES require auth — use the loader-style shape below with static credentials read from Secrets Manager.

### Staging / prod — shared replica set (TLS + SCRAM)

Use `loadMongoConfigFromAws()` to assemble config from the iac-published primitives. The loader connects as the per-service SCRAM user `{project}_app` against `{project}_db`.

```typescript
const config = await loadMongoConfigFromAws({
  scope: 'shared',
  env: 'staging',
  project: 'ledger-api',
  instanceName: 'main',
});

const provider = new MongoProvider(config);
await provider.connect();
container.bind(MONGO_CLIENT).toConstantValue(provider.getClient());
```

This:
- Reads `/shared/infra/staging/mongodb-{hosts,replica-set-name,ca-secret-arn}` from SSM
- Reads the CA cert from Secrets Manager via the published ARN
- Reads `staging/mongodb-shared/ledger-api-password` from Secrets Manager
- Returns a `MongoProviderConfig` with `tls: true`, `replicaSet: 'saga-rs'`, `authSource: 'ledger_api_db'`, multi-host
- The `MongoProvider` writes the CA cert content to a tmp file and references it via `tlsCAFile` in the URI

### Dev mirror — prod data, dev account

The prod-mirror in dev (`saga-mongodb-mirror-current`) restores from a recent prod snapshot. Per-service users on the mirror inherit prod's hashed passwords (which we don't have plaintext for), so the loader connects as the rotated master admin instead.

```typescript
const config = await loadMongoConfigFromAws({
  scope: 'mirror-current',
  project: 'ledger-api',          // used for default DB; admin can read any DB
  instanceName: 'mirror',
});
```

This connects as `saga_admin` against `admin` (authSource), with `database: 'ledger_api_db'` set as the default DB. Useful for one-off prod-shape investigations against the most recent mirror.

## Saga conventions (referenced by the loader)

| Concept | Convention |
|---|---|
| Project name → Mongo DB | `{project_with_underscores}_db` (e.g., `ledger-api` → `ledger_api_db`) |
| Project name → SCRAM user | `{project_with_underscores}_app` (e.g., `ledger_api_app`) |
| Per-project secret name (shared) | `{env}/mongodb-shared/{project}-password` (kept with hyphens) |
| Secret value shape | `{"username": "...", "password": "..."}` |
| Replica-set name | `saga-rs` (all envs) |
| TLS posture | `requireTLS` + `allowConnectionsWithoutCertificates` (SCRAM, no client cert) |
| Region | `us-west-2` (only) |

## SSM primitives consumed

| Scope | Path |
|---|---|
| `shared` | `/shared/infra/{env}/mongodb-hosts` |
| `shared` | `/shared/infra/{env}/mongodb-replica-set-name` |
| `shared` | `/shared/infra/{env}/mongodb-ca-secret-arn` |
| `mirror-current` | `/mirror/current/mongodb-shared/endpoint` |
| `mirror-current` | `/mirror/current/mongodb-shared/port` |
| `mirror-current` | `/mirror/current/mongodb-shared/replica-set-name` |
| `mirror-current` | `/mirror/current/mongodb-shared/ca-secret-arn` |
| `mirror-current` | `/mirror/current/mongodb-shared/master-secret-arn` |

## Testing

- `pnpm test` runs unit tests against the connection-string builder and a mocked AWS loader (using `aws-sdk-client-mock`), plus the in-memory `MockMongoProvider` integration test.
- `scripts/smoke-validate.mjs` is the canonical end-to-end smoke runner — exercises the real `MongoProvider` against three real systems via SSM port-forwards. See below.

### Validation via SSM tunnels

The end-to-end paths the unit tests can't reach — TLS handshake, SCRAM auth, CA-from-Secrets resolution — are exercised by `scripts/smoke-validate.mjs` against three representative targets:

| Target | Tests | Auth |
|---|---|---|
| `dev-shared-mongo` on db-host:27017 | no-TLS / no-auth path (legacy dev pattern) | none |
| `dev-auth-mongo` on db-host:27020 | TLS + SCRAM + per-service-user path | `ledger_api_app` (creds in `/dev/db-host/dev-auth-mongo/ledger-api-password`) |
| Staging shared mongo | TLS + SCRAM against the real shared cluster | master admin (`/shared/infra/staging/mongodb-master-secret-arn`) |

#### Setup

The targets are private-VPC EC2 with no stable instance IDs (db-host can be replaced; staging mongo runs under an ASG). Always resolve the current instance at runtime:

```bash
# Resolve current targets
DB_HOST=$(aws --profile saga-admin-dev ssm get-parameter \
  --name /dev/db-host/instance-id --query Parameter.Value --output text)
STG_MONGO=$(aws --profile saga-admin-dev ec2 describe-instances \
  --filters Name=tag:aws:autoscaling:groupName,Values=saga-mongodb-staging \
            Name=instance-state-name,Values=running \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)

# Open three SSM port-forwards (one per shell, or backgrounded)
aws --profile saga-admin-dev ssm start-session --target "$DB_HOST" \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["27017"],"localPortNumber":["27117"]}' &  # dev-shared-mongo
aws --profile saga-admin-dev ssm start-session --target "$DB_HOST" \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["27020"],"localPortNumber":["27120"]}' &  # dev-auth-mongo (testbed)
aws --profile saga-admin-dev ssm start-session --target "$STG_MONGO" \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["27017"],"localPortNumber":["27317"]}' &  # staging shared mongo
```

The `dev-auth-mongo` testbed lives on db-host alongside `dev-shared-mongo`; both share the same `/dev/db-host/instance-id` lookup. The dev-auth-mongo setup itself is in iac at `cloudformation_templates/dbs/db_host/dev-auth-mongo/`.

Then run the smoke:

```bash
AWS_PROFILE=saga-admin-dev node packages/node/db/scripts/smoke-validate.mjs
```

The script inserts → finds → deletes one doc per target, leaves no residue.

#### Why `directConnection: true`

The smoke passes `options: { directConnection: true }` and drops `replicaSet` for tunnel purposes. RS members advertise their internal VPC addresses (`10.3.137.46:27017`, `127.0.0.1:27017`, etc.) to the driver during topology discovery — those aren't reachable through an SSM tunnel from a workstation. `directConnection` skips topology discovery and pins the client to the seed (the tunneled `localhost:port`). Production callers in-VPC keep `replicaSet` and full RS topology — this is purely a tunneling accommodation.

#### Cert SAN

Both `dev-auth-mongo` and the staging shared cert include `localhost` in `subjectAltName`, so TLS hostname validation succeeds when connecting through `localhost:<port>` tunnels. Mirror and prod inherit the same SAN convention.

## Convention Deviations

None — follows all SOA patterns.

## See Also

- `/packages/node/api-core/` — API server utilities
- `/apps/node/CLAUDE.md` — Backend app patterns
- `/apps/node/claude/testing.md` — Database testing patterns
- `cloudformation_templates/dbs/mongodb_shared/` (iac) — Replica-set + TLS + SCRAM primitives this loader consumes
- `cloudformation_templates/dbs/db_host/dev-auth-mongo/` (iac) — Local TLS+SCRAM testbed for client work

---

*Last updated: 2026-05-01*
