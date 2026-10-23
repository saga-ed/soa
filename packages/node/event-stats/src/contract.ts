import { z } from 'zod';

export const REPORT_EVENT_TYPE = 'observability.event_stats.reported';
export const REPORT_EVENT_VERSION = 1;
export const isStatsEvent = (eventType: string): boolean =>
  eventType.startsWith('observability.event_stats.');
const label = z.string().min(1).max(128);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const measurement = count.nullable();
export const IdentitySchema = z.strictObject({
  service: label,
  environment: label,
  deployment: label,
  revision: label,
  instance: label,
  broker: label,
  vhost: label,
});
export const StreamSchema = z
  .strictObject({
    role: z.enum(['producer', 'consumer']),
    exchange: label,
    queue: label.optional(),
    consumer: label.optional(),
    eventType: label,
    eventVersion: z.number().int().positive().optional(),
  })
  .refine(
    s => s.role !== 'consumer' || Boolean(s.queue && s.consumer),
    'Consumer streams require queue and consumer'
  );
export const CountersSchema = z.strictObject({
  publishAttempts: measurement,
  publishAccepted: measurement,
  publishConfirmed: measurement,
  publishFailures: measurement,
  deliveries: measurement,
  redeliveries: measurement,
  commits: measurement,
  duplicates: measurement,
  processingFailures: measurement,
  ackIssued: measurement,
  ackFailed: measurement,
  nackIssued: measurement,
  nackFailed: measurement,
  requeues: measurement,
});
export const ReportSchema = z.strictObject({
  version: z.literal(1),
  reportId: z.uuid(),
  identity: IdentitySchema,
  epoch: z.uuid(),
  sequence: count.positive(),
  startedAt: z.iso.datetime(),
  observedAt: z.iso.datetime(),
  elapsedMs: z.number().finite().nonnegative(),
  capabilities: z
    .array(z.enum(['producer', 'consumer']))
    .min(1)
    .max(2),
  streams: z
    .array(
      z.strictObject({
        stream: StreamSchema,
        counters: CountersSchema,
        latestSuccessAt: z.iso.datetime().nullable(),
        failureReasons: z.strictObject({
          transport: count,
          backpressure: count,
          envelope: count,
          unsupported: count,
          schema: count,
          database: count,
          handler: count,
          commit: count,
        }),
      })
    )
    .max(1024),
  diagnostics: z.strictObject({
    droppedObservations: count,
    reportingFailures: count,
    oversizedReports: count,
    saturatedCounters: count,
  }),
});
export type Identity = z.infer<typeof IdentitySchema>;
export type Stream = z.infer<typeof StreamSchema>;
export type Counters = z.infer<typeof CountersSchema>;
export type Report = z.infer<typeof ReportSchema>;
export type Counter = keyof Counters;
