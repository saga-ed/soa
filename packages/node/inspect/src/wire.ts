// Wire contract for the inspect surface (microservices#662). These schemas
// are the single source of truth for what travels between a service's
// /inspect router and the sandbox visibility console — the console validates
// every response against them, so a service on an older soa-inspect version
// fails loudly instead of rendering garbage.
import { z } from 'zod';

// ---- Manifest ----

export const EntityFieldInfoSchema = z.object({
    name: z.string(),
    /** Best-effort primitive hint derived from the descriptor's Zod schema
     * (string | number | boolean | date | enum | …). Display hint only —
     * the console must not branch on values outside this set. */
    type: z.string(),
    optional: z.boolean(),
    nullable: z.boolean(),
    /** Console masks these by default (click-to-reveal). */
    pii: z.boolean(),
});
export type EntityFieldInfo = z.infer<typeof EntityFieldInfoSchema>;

export const ManifestEntitySchema = z.object({
    name: z.string(),
    displayName: z.string().optional(),
    fields: z.array(EntityFieldInfoSchema),
    searchFields: z.array(z.string()),
    supportsGet: z.boolean(),
});
export type ManifestEntity = z.infer<typeof ManifestEntitySchema>;

export const InspectEventsInfoSchema = z.object({
    exchange: z.string().optional(),
    /** Published event keys, e.g. 'iam.user.created.v1'. */
    published: z.array(z.string()).optional(),
    /** consumed_events.consumer_name values this service projects under. */
    consumerNames: z.array(z.string()).optional(),
});
export type InspectEventsInfo = z.infer<typeof InspectEventsInfoSchema>;

export const InspectGatesSchema = z.object({
    entities: z.boolean(),
    status: z.boolean(),
});
export type InspectGates = z.infer<typeof InspectGatesSchema>;

export const InspectManifestSchema = z.object({
    service: z.string(),
    contractVersion: z.literal(1),
    gates: InspectGatesSchema,
    entities: z.array(ManifestEntitySchema),
    events: InspectEventsInfoSchema.optional(),
});
export type InspectManifest = z.infer<typeof InspectManifestSchema>;

// ---- Projection status ----

export const OutboxStatusSchema = z.object({
    /** Monotonic publisher head when the outbox has one (e.g. max(id)). */
    headPosition: z.string().nullable().optional(),
    headOccurredAt: z.string().nullable(),
    unpublishedCount: z.number().int().nullable().optional(),
    lastPublishedAt: z.string().nullable().optional(),
});
export type OutboxStatus = z.infer<typeof OutboxStatusSchema>;

export const ConsumerStatusSchema = z.object({
    consumerName: z.string(),
    lastProcessedAt: z.string().nullable(),
    consumedCount: z.number().int(),
});
export type ConsumerStatus = z.infer<typeof ConsumerStatusSchema>;

export const InspectStatusResponseSchema = z.object({
    service: z.string(),
    generatedAt: z.string(),
    /** null when this service publishes no events (or its outbox table is absent). */
    outbox: OutboxStatusSchema.nullable(),
    /** Empty when this service projects nothing. */
    consumers: z.array(ConsumerStatusSchema),
});
export type InspectStatusResponse = z.infer<typeof InspectStatusResponseSchema>;

// ---- Entity listing ----

export const ListQuerySchema = z.object({
    limit: z.coerce.number().int().positive().max(200).default(50),
    offset: z.coerce.number().int().nonnegative().default(0),
    search: z.string().trim().min(1).optional(),
});
export type ListQuery = z.infer<typeof ListQuerySchema>;

export const EntityListResponseSchema = z.object({
    entity: z.string(),
    rows: z.array(z.record(z.string(), z.unknown())),
    total: z.number().int(),
    limit: z.number().int(),
    offset: z.number().int(),
});
export type EntityListResponse = z.infer<typeof EntityListResponseSchema>;
