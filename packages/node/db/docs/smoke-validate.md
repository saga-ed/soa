# db — end-to-end smoke validation via SSM tunnels

> Reference runbook for `scripts/smoke-validate.mjs`. Extracted from the package
> CLAUDE.md to keep that file under the 200-line budget; this detail only
> matters when running the real-systems smoke against `MongoProvider`.

**Parent Context:** how-to detail for [`@saga-ed/soa-db`](../CLAUDE.md).

The end-to-end paths the unit tests can't reach — TLS handshake, SCRAM auth, CA-from-Secrets resolution — are exercised by `scripts/smoke-validate.mjs` against three representative targets:

| Target | Tests | Auth |
|---|---|---|
| `dev-shared-mongo` on db-host:27017 | no-TLS / no-auth path (legacy dev pattern) | none |
| `dev-auth-mongo` on db-host:27020 | TLS + SCRAM + per-service-user path | `ledger_api_app` (creds in `/dev/db-host/dev-auth-mongo/ledger-api-password`) |
| Staging shared mongo | TLS + SCRAM against the real shared cluster | master admin (`/shared/infra/staging/mongodb-master-secret-arn`) |

## Setup

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

## Why `directConnection: true`

The smoke passes `options: { directConnection: true }` and drops `replicaSet` for tunnel purposes. RS members advertise their internal VPC addresses (`10.3.137.46:27017`, `127.0.0.1:27017`, etc.) to the driver during topology discovery — those aren't reachable through an SSM tunnel from a workstation. `directConnection` skips topology discovery and pins the client to the seed (the tunneled `localhost:port`). Production callers in-VPC keep `replicaSet` and full RS topology — this is purely a tunneling accommodation.

## Cert SAN

Both `dev-auth-mongo` and the staging shared cert include `localhost` in `subjectAltName`, so TLS hostname validation succeeds when connecting through `localhost:<port>` tunnels. Mirror and prod inherit the same SAN convention.
