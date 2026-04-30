import { z } from 'zod';

/**
 * Config schema for MongoProvider.
 *
 * Supports two connection topologies:
 *
 * 1. Single-host, no auth, no TLS — local docker-compose mongo (e.g., dev
 *    on db-host:27018). Pass a one-element `hosts` array, leave `replicaSet`,
 *    `tls`, and `authSource` unset.
 *
 * 2. Multi-host replica set with TLS + SCRAM — staging / prod / dev mirror.
 *    `hosts` lists every replica-set member as `host:port`, `replicaSet`
 *    identifies the RS, `tls: true` requires TLS, `authSource` is the database
 *    where the SCRAM user was created (per Saga convention: `{project}_db`),
 *    and the CA cert is supplied via either `tlsCAFile` (path on disk) or
 *    `tlsCAContent` (PEM string — typically read from Secrets Manager and
 *    written to a tmp file by the provider at construction).
 *
 * For staging/prod/mirror, prefer `loadMongoConfigFromAws()` from
 * `./aws-mongo-loader.js` which assembles this config from the SSM/Secrets
 * primitives published by `cloudformation_templates/dbs/mongodb_shared/`.
 */
export const MongoProviderSchema = z.object({
  configType: z.literal('MONGO'),
  instanceName: z.string().min(1),

  // Replica-set members (or a single host for non-RS deployments).
  // Each entry is `host:port`. Order doesn't matter — the driver discovers
  // the primary via the seed list.
  hosts: z.array(z.string().min(1)).min(1),

  database: z.string().min(1),
  username: z.string().optional(),
  password: z.string().optional(),

  // Replica-set name. When set, the driver treats `hosts` as a seed list
  // and discovers all members. Required for multi-host deployments.
  replicaSet: z.string().optional(),

  // Database the SCRAM user authenticates against. Defaults to `database`
  // when unset. For Saga's per-service users, this is the project's own DB
  // (e.g., `ledger_api_db`), since createUser ran in that DB.
  authSource: z.string().optional(),

  // TLS toggle. When true:
  //   - The connection string adds `tls=true`.
  //   - If `tlsCAContent` is provided, the provider writes it to a tmp file
  //     once and adds `tlsCAFile=<path>` to the URI.
  //   - If `tlsCAFile` is provided, that path is used directly.
  //   - If neither is provided, the driver uses the system CA bundle.
  tls: z.boolean().optional(),
  tlsCAFile: z.string().optional(),
  tlsCAContent: z.string().optional(),

  // Pass-through options handed to `new MongoClient(uri, options)`. Avoid
  // putting auth/TLS/RS settings here — prefer the typed fields above so
  // the connection-string builder and tests stay coherent.
  options: z.record(z.string(), z.any()).optional(),
});

export type MongoProviderConfig = z.infer<typeof MongoProviderSchema>;
