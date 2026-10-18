import type { Capabilities, CapabilityDeclaration, EnvIdentity, LaneParse, ResolvedAccount } from './types.js';

export type * from './types.js';
export type Vars = Readonly<Record<string, string | undefined>>;

/** Pure. Strict on LANE alone (no EXEC_ENV alias; that shim stays in lane-guard). Never throws. */
export declare function parseLane(vars: Vars): LaneParse;

/** ECS metadata then STS. Throws or returns undefined on failure; never defaults. */
export declare function resolveAccount(vars: Vars): Promise<ResolvedAccount | undefined>;

/** Pure identity parse. Unknown or conflicting values throw EnvIdentityError (fail closed to prod profile). */
export declare function parseIdentity(vars: Vars, account: ResolvedAccount): EnvIdentity;

/** Config source: SSM/samconfig params in deployed envs, in-memory in tests. */
export interface ConfigSource {
    get(key: string): string | undefined;
}

/** Pure. Validates the profile x lane x account invariant table; throws EnvInvariantError listing all violations. */
export declare function createEnv(
    decl: CapabilityDeclaration,
    identity: EnvIdentity,
    config: ConfigSource,
): Readonly<Capabilities>;

/** Boot entry: reads process.env once, resolves account, builds capabilities. The only process.env reader. */
export declare function loadEnv(decl: CapabilityDeclaration, config: ConfigSource): Promise<Readonly<Capabilities>>;

/** Subpath `@saga-ed/soa-env/testing`: prod-profile identity with dev bindings. */
export declare function testEnv(overrides?: Partial<Capabilities>): Readonly<Capabilities>;
