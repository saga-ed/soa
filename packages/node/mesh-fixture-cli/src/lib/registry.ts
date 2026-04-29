/**
 * registry — post-mutation writes + reads against the per-service
 * snapshot.registry.* routers (D3.2). Each of iam-api, programs-api,
 * scheduling-api, ads-adm-api exposes the same 5-procedure shape:
 *
 *   snapshot.registry.upsert       — mutation, { id, description?, artifacts?, snapshotProfile?, snapshotAt?, schemaRev? }
 *   snapshot.registry.get          — query,    { id }           → SnapshotMetadata
 *   snapshot.registry.list         — query                       → SnapshotMetadata[]
 *   snapshot.registry.addCommand   — mutation, { id, command: CommandInfo }
 *   snapshot.registry.delete       — mutation, { id }
 *
 * This module owns two concerns:
 *   1. Route each iam: / pgm: / ads: CLI command to its owning service's
 *      registry and POST a CommandInfo after the business mutation succeeds.
 *   2. Offer snapshot:show / snapshot:validate the cross-service read path.
 *
 * addCommand calls are best-effort — a registry write failure should log a
 * warning but not fail the enclosing fixture-author command, because the
 * domain work (iam:create-org, pgm:create-program, …) already succeeded.
 */

import { TrpcClient, TrpcCallError, type TrpcTransformer } from './http.js';

/**
 * The four services that back `snapshot.registry.*`. Used to route command
 * writes and aggregate reads in snapshot:show / snapshot:validate.
 */
export type RegistryService = 'iam' | 'programs' | 'scheduling' | 'ads';

/**
 * Minimum service surface. URLs + transformer choice. Only ads-adm-api
 * speaks superjson; the rest speak plain JSON.
 */
export interface RegistryServiceConfig {
  service: RegistryService;
  url: string;
  transformer: TrpcTransformer;
}

/**
 * Snapshot of one invocation. Shape fixed by the fixture-registry-model
 * spec §1.1. `args` is sanitized at the call-site — no cookies, no URL
 * overrides, no devLogin identity. `gitSha` is optional; we leave it
 * undefined until the CLI gains a build-time stamp.
 */
export interface CommandInfo {
  command: string;
  args: Record<string, unknown>;
  timestamp: string;
  cliVersion: string;
  gitSha?: string;
}

/**
 * SnapshotMetadata as returned by snapshot.registry.get. All dates arrive
 * as ISO strings on plain-JSON services; on ads-adm-api's superjson path
 * the wrapper strips the meta but values may come back tagged — callers
 * just treat these as strings.
 */
export interface SnapshotMetadata {
  id: string;
  createdAt: string;
  lastUpdated: string;
  description: string | null;
  artifacts: Record<string, unknown>;
  commandHistory: CommandInfo[];
  snapshotProfile: string | null;
  snapshotAt: string | null;
  schemaRev: string | null;
}

/** CLI version embedded in every CommandInfo. Keep in sync with package.json. */
export const CLI_VERSION = '0.0.1';

/**
 * iam:* / pgm:* / ads:* commands → the service that should record the
 * CommandInfo. Anchors the one-service-one-command-prefix mapping from
 * the phase-3 brief.
 */
export function serviceFor(command: string): RegistryService {
  if (command.startsWith('iam:')) return 'iam';
  if (command.startsWith('pgm:')) return 'programs';
  if (command.startsWith('ads:')) return 'ads';
  // snapshot:* commands that record against a specific service are
  // called with the explicit service form (recordCommandOn); anything
  // else is programmer error.
  throw new Error(
    `serviceFor: no registry mapping for command '${command}'. ` +
      `Use recordCommandOn(service, …) to target a service explicitly.`,
  );
}

/**
 * Inputs the mesh-fixture commands carry at runtime — collected here so
 * recordCommand / getRegistry don't need five positional args.
 */
export interface RegistryEndpoints {
  'iam-url': string;
  'programs-url': string;
  'ads-adm-url': string;
  /**
   * scheduling-url override. No shared CLI flag yet; derived from
   * SCHEDULING_API_URL (or programs-url host + :3008) when missing.
   */
  'scheduling-url'?: string;
}

export function resolveServiceUrl(
  service: RegistryService,
  endpoints: RegistryEndpoints,
): string {
  switch (service) {
    case 'iam':
      return endpoints['iam-url'];
    case 'programs':
      return endpoints['programs-url'];
    case 'ads':
      return endpoints['ads-adm-url'];
    case 'scheduling':
      return (
        endpoints['scheduling-url'] ??
        process.env['SCHEDULING_API_URL'] ??
        'http://localhost:3008'
      );
  }
}

function transformerFor(service: RegistryService): TrpcTransformer {
  // ads-adm-api is built on @saga-ed/soa-trpc-base, which ships with the
  // superjson transformer enabled by default. iam-api + programs-api +
  // scheduling-api use plain JSON.
  return service === 'ads' ? 'superjson' : 'none';
}

export function clientFor(
  service: RegistryService,
  endpoints: RegistryEndpoints,
): TrpcClient {
  return new TrpcClient({
    baseUrl: resolveServiceUrl(service, endpoints),
    transformer: transformerFor(service),
  });
}

/**
 * Best-effort append to `artifacts.<kind>`. Reads the current registry row,
 * merges a new id into the named bucket, and upserts. Safe to call with a
 * new fixture-id — get() returns null and upsert creates the row.
 *
 * Called alongside recordCommand so snapshot:validate has something concrete
 * to walk. Same service-routing rules as recordCommand (iam: → iam-api,
 * pgm: → programs-api, …). Failures are logged but don't break callers.
 */
export async function appendArtifact(
  command: string,
  fixtureId: string,
  kind: string,
  id: string,
  endpoints: RegistryEndpoints,
): Promise<void> {
  const service = serviceFor(command);
  return appendArtifactOn(service, fixtureId, kind, id, endpoints);
}

export async function appendArtifactOn(
  service: RegistryService,
  fixtureId: string,
  kind: string,
  id: string,
  endpoints: RegistryEndpoints,
): Promise<void> {
  const client = clientFor(service, endpoints);
  try {
    const existing = await getRegistry(service, fixtureId, endpoints);
    const artifacts: Record<string, unknown> = { ...(existing?.artifacts ?? {}) };
    const bucket = Array.isArray(artifacts[kind])
      ? [...(artifacts[kind] as string[])]
      : [];
    if (!bucket.includes(id)) bucket.push(id);
    artifacts[kind] = bucket;
    await client.mutation('snapshot.registry.upsert', {
      id: fixtureId,
      artifacts,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `  warn   snapshot.registry.upsert artifacts.${kind} (${service}): ${msg}\n`,
    );
  }
}

/**
 * Best-effort recordCommand. Routes to the service implied by the command
 * name. Emits a warning to stderr on failure (network error, 500, …) and
 * resolves — the caller's domain mutation already succeeded and shouldn't
 * be undone just because the audit write tripped.
 */
export async function recordCommand(
  command: string,
  fixtureId: string,
  args: Record<string, unknown>,
  endpoints: RegistryEndpoints,
): Promise<void> {
  const service = serviceFor(command);
  return recordCommandOn(service, command, fixtureId, args, endpoints);
}

export async function recordCommandOn(
  service: RegistryService,
  command: string,
  fixtureId: string,
  args: Record<string, unknown>,
  endpoints: RegistryEndpoints,
): Promise<void> {
  const client = clientFor(service, endpoints);
  const info: CommandInfo = {
    command,
    args,
    timestamp: new Date().toISOString(),
    cliVersion: CLI_VERSION,
  };
  try {
    await client.mutation('snapshot.registry.addCommand', { id: fixtureId, command: info });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `  warn   snapshot.registry.addCommand (${service}): ${msg}\n`,
    );
  }
}

/**
 * Query one service's registry for a fixture id. Returns null on NOT_FOUND
 * instead of throwing. Network / auth / other 5xx errors propagate so
 * snapshot:show / snapshot:validate can surface them.
 */
export async function getRegistry(
  service: RegistryService,
  fixtureId: string,
  endpoints: RegistryEndpoints,
): Promise<SnapshotMetadata | null> {
  const client = clientFor(service, endpoints);
  try {
    return await client.query<SnapshotMetadata>('snapshot.registry.get', {
      id: fixtureId,
    });
  } catch (err) {
    if (
      err instanceof TrpcCallError &&
      (err.trpcError?.data?.code === 'NOT_FOUND' || err.status === 404)
    ) {
      return null;
    }
    throw err;
  }
}

/**
 * Sanitize a flags object for inclusion in a CommandInfo.args field.
 * Drops CLI-runtime-only flags (URLs, output shape, auth identity) and
 * keeps the domain-meaningful ones. Caller passes the full oclif flags
 * object; we filter by key.
 */
const ARG_DROP_KEYS = new Set([
  'porcelain',
  'output-json',
  'iam-url',
  'programs-url',
  'scheduling-url',
  'ads-adm-url',
  'as', // auth identity, not a domain arg
  'fixture-id', // already carried by the outer addCommand payload
]);

export function sanitizeArgs(
  flags: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(flags)) {
    if (ARG_DROP_KEYS.has(k)) continue;
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}
