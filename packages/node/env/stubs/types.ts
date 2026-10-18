// Interface stubs only (soa#515 design). No implementation, no package.json yet.

/** Behaviour profile: which code branches run. Axis 1 of the twin lane contract. */
export type Profile = 'prod' | 'local';

/** Lane identity: set by infra, never app config. Axis 2. */
export type Lane = 'twin' | 'mirror' | 'none';

/** Result of the strict LANE parse (trim + lowercase; unset/empty = none). */
export type LaneParse = { lane: Lane } | { lane: 'invalid'; reason: string };

/** Account axis. `local` is legal only when no ECS metadata endpoint exists. Axis 4. */
export type AccountKind = 'prod' | 'dev' | 'local';
export interface ResolvedAccount {
    kind: AccountKind;
    /** 12-digit id; absent only for `local`. */
    id?: string;
}

/** Telemetry env. Axis 3: independent of profile. */
export type TelemetryEnv = string;

export type CredentialSource = 'iam-token' | 'static';
export type MailSink = 'ses' | 'stub' | 'sandbox-ses' | 'capture';

/** Every outward effect is a named binding; `off` is an explicit value, never absence. */
export type OutboundBinding = 'live' | 'sink' | 'off';

export interface TlsCapability {
    /** Pinned CA bundle path when set; rejectUnauthorized stays true. */
    caBundlePath?: string;
    required: boolean;
}

export interface Capabilities {
    credentialSource: CredentialSource;
    tls: TlsCapability;
    /** true: dependency-resolution failure at boot aborts the process. */
    failFast: boolean;
    mailSink: MailSink;
    corsOrigins: readonly (string | RegExp)[];
    cookieDomain: string;
    trustProxyHops: number;
    telemetryEnv: TelemetryEnv;
    /** Auth-bypass surfaces (dev perimeter, permissive authz). Must be false when profile=prod. */
    devAuthSurfaces: boolean;
    /** Per integration: clever, partner-webhooks, lake-export, outbox-relay, datadog, ... */
    outbound: Readonly<Record<string, OutboundBinding>>;
}

export interface EnvIdentity {
    profile: Profile;
    lane: Lane;
    telemetryEnv: TelemetryEnv;
    account: ResolvedAccount;
}

/** Declared per service; resolved against identity + config source. */
export interface CapabilityDeclaration {
    service: string;
    /** Integrations this service has; unknown outbound keys are a boot error. */
    outbound: readonly string[];
    /** Config keys (one per capability) read from the config source. */
    keys: Partial<Record<keyof Capabilities, string>>;
}
