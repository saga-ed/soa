/** Source-verified capabilities; these do not assert that a relay/consumer is healthy. */
export const busRoles: Record<string, { publishes: boolean; consumes: boolean; evidence: string }> = {
  'programs-api': { publishes: true, consumes: true, evidence: 'program-hub/apps/node/programs-api/src/main.ts starts OutboxRelay, IamProjectionConsumer, SlotProjectionConsumer, AdhocPodAssignmentConsumer and reconciliation consumers.' },
  'scheduling-api': { publishes: true, consumes: true, evidence: 'program-hub/apps/node/scheduling-api/src/inversify.config.ts wires OutboxRelay and ProgramsProjectionConsumer; src/main.ts starts them.' },
  'sessions-api': { publishes: true, consumes: true, evidence: 'program-hub/apps/node/sessions-api/src/main.ts starts OutboxRelay, ProgramsProjectionConsumer, SchedulingProjectionConsumer and IamUserProjectionConsumer.' },
  'content-api': { publishes: true, consumes: false, evidence: 'program-hub/apps/node/content-api/src/inversify.config.ts wires OutboxRelay and explicitly documents no inbound consumer.' },
  'iam-api': { publishes: true, consumes: false, evidence: 'rostering/apps/node/iam-api/src/main.ts starts OutboxRelay for iam.* events. No consumer role has been verified.' },
  'authz-api': { publishes: false, consumes: true, evidence: 'rostering/apps/node/authz-api/src/main.ts starts IAM_PROJECTION_CONSUMER. No publisher role has been verified.' },
};
