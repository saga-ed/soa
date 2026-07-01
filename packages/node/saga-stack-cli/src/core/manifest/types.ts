/**
 * Service-manifest types — the single source of truth for the stack topology.
 *
 * This module is PURE: it declares only types and carries zero IO. The manifest
 * data (databases.ts / mesh.ts / services.ts) is assembled and frozen in
 * index.ts. `ServiceId` / `DbId` / `MeshId` are closed string-literal unions so
 * a typo in a `dependsOn` / `databases` / `mesh` edge is a COMPILE error — the
 * dependency-closure engine's correctness rests on well-formed edges.
 *
 * Schema matches plan §2.2 exactly (saga-ed/soa#214). Do not redeclare these
 * unions anywhere else — `core/seed/`, `closure.ts`, etc. import from here.
 */

/** The 10 core services + rtsm + the coach pair + the 3 optional (`--with-playback`) playback APIs. */
export type ServiceId =
  | 'iam-api'
  | 'sis-api'
  | 'programs-api'
  | 'scheduling-api'
  | 'sessions-api'
  | 'content-api'
  | 'ads-adm-api'
  | 'saga-dash'
  | 'connect-api'
  | 'connect-web'
  | 'rtsm-api'
  | 'coach-api' //       coach-api (:6105) — Coach professional-development GraphQL/tRPC
  | 'coach-web' //       coach-web (:8800) — SvelteKit SPA (reaches iam THROUGH coach-api)
  | 'transcripts-api' // optional: true (--with-playback)
  | 'insights-api' //    optional: true (--with-playback)
  | 'chat-api'; //       optional: true (--with-playback)

/** Mesh infra units, started as a single `make up PROFILE=empty`. */
export type MeshId = 'postgres' | 'redis' | 'rabbitmq' | 'connect-mongo';

/** Sibling-repo env-var keys (mirror up.sh:173-181). `repoRoot = $<key> ?? $DEV/<default>`. */
export type RepoKey =
  | 'SOA'
  | 'ROSTERING'
  | 'PROGRAM_HUB'
  | 'SAGA_DASH'
  | 'COACH'
  | 'SDS'
  | 'QBOARD'
  | 'RTSM'
  | 'FLEEK';

/** The three URL lanes a service can be addressed on. */
export type Lane = 'stack' | 'sandbox' | 'tunnel';

/** How one service depends on another — constrains launch order and/or health gating. */
export type DepKind = 'url' | 's2s' | 'event' | 'browser';

/** Database engine. */
export type Engine = 'postgres' | 'mongo';

/**
 * The 14 databases. The literal equals the real DB `name` (so `DbId` doubles as
 * the postgres/mongo database name). `connectv3` is mongo; the rest are postgres.
 */
export type DbId =
  | 'iam_local'
  | 'iam_pii_local'
  | 'programs'
  | 'scheduling'
  | 'sessions'
  | 'content'
  | 'coach_api'
  | 'sis_db'
  | 'ads_adm_local'
  | 'ledger_local'
  | 'transcripts_local'
  | 'insights_local'
  | 'chat_local'
  | 'connectv3';

/** Canonical SeedStep ids (see §4). Referenced by `ServiceDef.seed`. */
export type SeedStepRef =
  | 'iam-dev-user'
  | 'iam'
  | 'sessions'
  | 'qtf-demo'
  | 'programs'
  | 'content'
  | 'transcripts'
  | 'insights'
  | 'chat';

/** How a DB's schema is applied. `dir` is repo-relative to the OWNING service's repo. */
export interface MigrateSpec {
  /** Repo-relative dir that OWNS the schema (e.g. `packages/node/iam-db`). */
  dir: string;
  cmd: 'db:deploy' | 'prisma migrate deploy' | 'prisma db push';
  /** Force the mesh :5432 DATABASE_URL (program-hub apps default to their own :5433). */
  databaseUrlOverride?: boolean;
}

export interface DatabaseDef {
  /** The real DB name; equals this entry's `DbId` key. */
  name: string;
  engine: Engine;
  /** null ⇒ no schema (mongo auto-create / stateless). */
  migrate: MigrateSpec | null;
  /** restore-as identity (snapshot invariant #2). */
  ownerRole: string;
  ownerPw: string;
  /** Included in `stack reset`. */
  resettable: boolean;
  /**
   * 'truncate' preserves `_prisma_migrations`; 'migrate-reset' = drop + remigrate
   * (ledger_local — decision 2026-06-29).
   */
  resetMode: 'truncate' | 'migrate-reset';
  /** Created by profile-empty.sql at mesh-up. */
  meshProvisioned: boolean;
}

/** Per-lane URL templates for a service (tokens resolved at launch by `lane()`). */
export interface LaneTemplates {
  stack: string;
  sandbox: string;
  tunnel: string;
}

export interface ServiceDef {
  id: ServiceId;
  repo: RepoKey;
  subpath: string;
  port: number;
  /** Env var the launch line sets the port through, or null when the app reads its own .env. */
  portEnvVar?: 'PORT' | 'EXPRESS_SERVER_PORT' | null;
  /** '/health' | '/' | '/connectv3/v1/health'. */
  healthPath: string;
  databases: DbId[];
  dependsOn: ServiceId[];
  depKinds: Partial<Record<ServiceId, DepKind>>;
  mesh: MeshId[];
  /** Launch command + env. Tokens (e.g. `${IAM_URL}`) are resolved at launch by lane(); M0 does not execute them. */
  launch: { cmd: string; env: Record<string, string> };
  /** Canonical SeedStep ids this service contributes (see §2.2 + §4). */
  seed: SeedStepRef[];
  lane: LaneTemplates;
  /** PUBLIC host slug for the tunnel lane (review major) — NOT the ServiceId. */
  tunnelSlug: string;
  isFrontend: boolean;
  optional: boolean;
  /** Config-file prep run immediately before this service boots (review minor — §3). */
  prelaunchHook?: 'sync-dash-local-defaults';
}

export interface MeshDef {
  id: MeshId;
  /** docker-compose container name (overridable via env in the runtime adapter). */
  container: string;
  port: number;
  /** Management/secondary port where one exists (e.g. rabbitmq mgmt 15672). */
  mgmtPort?: number;
  /** Shell command that returns 0 when the unit is ready. */
  readinessCmd: string;
  /** Max seconds to wait for readiness. */
  timeoutSec: number;
}

export interface Manifest {
  services: Readonly<Record<ServiceId, ServiceDef>>;
  databases: Readonly<Record<DbId, DatabaseDef>>;
  mesh: Readonly<Record<MeshId, MeshDef>>;
}
