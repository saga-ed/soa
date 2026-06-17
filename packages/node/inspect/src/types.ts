import type { ZodType } from 'zod';
import type { ConsumerStatus, InspectEventsInfo, InspectGates, ListQuery, OutboxStatus } from './wire.js';

export interface ListResult<T> {
    rows: T[];
    total: number;
}

/**
 * One browsable entity, declared by the service that owns it. This is the
 * whole per-service integration surface: a name, a row schema (introspected
 * into the manifest so the console can render without service-specific
 * code), PII field names, and the queries.
 */
export interface EntityDescriptor<T> {
    /** URL-safe key, e.g. 'users'. Unique within the service. */
    name: string;
    displayName?: string;
    /** Row shape. Must be a z.object(...) for manifest field extraction. */
    schema: ZodType<T>;
    /** Field names the console masks by default. */
    pii?: string[];
    /** Fields the `search` query param matches against (documentation for
     * the console; the list() implementation owns the actual behavior). */
    searchFields?: string[];
    list(query: ListQuery): Promise<ListResult<T>>;
    get?(id: string): Promise<T | null>;
}

// Descriptors are declared with concrete row types but stored heterogeneously.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyEntityDescriptor = EntityDescriptor<any>;

/** Erases the row type so concretely-typed descriptors can share a config array. */
export function defineEntity<T>(descriptor: EntityDescriptor<T>): AnyEntityDescriptor {
    return descriptor;
}

/**
 * Publisher/consumer watermark providers. Callbacks rather than table names
 * because outbox shapes legitimately differ across the fleet (iam-api's
 * `event_outbox` is a poll-model bigserial outbox with no published_at;
 * canonical relay services use `outbox_event`). Services on the canonical
 * tables can use canonicalOutboxStatus()/canonicalConsumerStatus().
 */
export interface StatusProviders {
    outbox?: () => Promise<OutboxStatus | null>;
    consumers?: () => Promise<ConsumerStatus[]>;
}

/** Minimal logger so the package doesn't depend on a logging framework. */
export interface InspectLogger {
    warn(message: string): void;
    error(message: string): void;
}

export interface InspectConfig {
    /** Service identity reported in every response, e.g. 'iam-api'. */
    service: string;
    entities: AnyEntityDescriptor[];
    events?: InspectEventsInfo;
    status?: StatusProviders;
    /**
     * Static bearer expected from the console BFF (microservices#662 auth
     * decision). Undefined ⇒ the whole surface answers 404, indistinguishable
     * from a service without soa-inspect — default-off is the contract.
     */
    token: string | undefined;
    gates: InspectGates;
    logger?: InspectLogger;
}
