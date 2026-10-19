/** `saga.readiness/v1` JSON Schema and types. No runtime dependency; consumers bring their own validator. */
export type {
  ReadinessReport,
  DependencyReport,
  ReadinessVerdict,
  DependencyState,
  ProbeReason,
  DependencyKind,
  BootMode,
} from './deep/types.js';

export const READINESS_SCHEMA_ID = 'saga.readiness/v1';

const reasons = [
  'timeout', 'connection_refused', 'dns', 'tls', 'auth', 'schema',
  'unexpected_response', 'not_ready', 'pool_exhausted', 'error',
];
const counts = {
  type: 'object',
  required: ['ok', 'failing'],
  additionalProperties: false,
  properties: { ok: { type: 'integer', minimum: 0 }, failing: { type: 'integer', minimum: 0 } },
} as const;

export const readinessReportJsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://saga.org/schemas/readiness/v1.json',
  title: 'saga.readiness/v1',
  type: 'object',
  required: ['schema', 'service', 'verdict', 'httpStatus', 'build', 'generatedAt', 'bootMode', 'summary'],
  properties: {
    schema: { const: READINESS_SCHEMA_ID },
    service: { type: 'string' },
    verdict: { enum: ['ready', 'degraded', 'not_ready', 'starting', 'draining'] },
    httpStatus: { enum: [200, 503] },
    build: {
      type: 'object',
      properties: {
        colour: { type: 'string' },
        version: { type: 'string' },
        environment: { type: 'string' },
        deployedAt: { type: 'string' },
        profile: { enum: ['prod', 'dev'] },
        lane: { enum: ['twin', 'mirror', 'none'] },
        telemetryEnv: { type: 'string' },
        accountKind: { enum: ['prod', 'dev', 'local'] },
      },
    },
    generatedAt: { type: 'string', format: 'date-time' },
    bootMode: { enum: ['block', 'warn', 'open'] },
    summary: {
      type: 'object',
      required: ['critical', 'optional'],
      additionalProperties: false,
      properties: { critical: counts, optional: counts },
    },
    dependencies: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'kind', 'criticality', 'state', 'consecutiveFailures', 'level'],
        properties: {
          name: { type: 'string' },
          kind: { type: 'string' },
          criticality: { enum: ['critical', 'optional'] },
          scope: { enum: ['task', 'shared'] },
          state: { enum: ['starting', 'ok', 'degraded', 'failing', 'stale', 'skipped'] },
          reason: { enum: reasons },
          latencyMs: { type: 'integer', minimum: 0 },
          lastSuccessAgeMs: { type: 'integer', minimum: 0 },
          consecutiveFailures: { type: 'integer', minimum: 0 },
          level: { enum: ['cached', 'deep'] },
        },
      },
    },
    checks: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        required: ['ready', 'detail'],
        properties: { ready: { type: 'boolean' }, detail: { type: 'string' } },
      },
    },
  },
} as const;
