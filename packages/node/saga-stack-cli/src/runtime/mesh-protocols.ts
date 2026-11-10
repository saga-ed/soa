/** Source-verified client transports, not inferred from HTTP verbs or dependency kinds.
 * These describe supported wiring, not traffic observed in the current slot.
 */
export function httpProtocol(source: string, target: string): { protocol: 'trpc' | 'rest' | 'mixed' | 'unknown'; evidence: string } {
  if (source === 'saga-dash' && ['iam-api', 'sis-api', 'programs-api', 'scheduling-api', 'sessions-api', 'content-api'].includes(target)) {
    return { protocol: 'trpc', evidence: 'saga-dash/packages/core/dash-data/src/trpc/clients.ts creates HTTP tRPC clients for these services.' };
  }
  if (source === 'saga-dash' && target === 'ads-adm-api') {
    return { protocol: 'trpc', evidence: 'saga-dash/packages/web/pages/adm/src/lib/api/ads-client.ts uses the /trpc transport.' };
  }
  if (source === 'ads-adm-api' && target === 'iam-api') {
    return { protocol: 'mixed', evidence: 'student-data-system/apps/node/ads-adm-api/src/clients/iam-api.client.ts uses tRPC; service-token-provider.ts supports REST POST /v1/oauth/token. Token exchange is configuration-dependent and may be bypassed locally.' };
  }
  if (source === 'sis-api' && target === 'iam-api') {
    return { protocol: 'mixed', evidence: 'rostering/apps/node/sis-api/src/clients/iam.client.ts uses httpBatchLink and REST token acquisition. Token exchange is configuration-dependent.' };
  }
  if (source === 'ads-adm-api' && ['sessions-api', 'programs-api'].includes(target)) {
    return { protocol: 'trpc', evidence: `student-data-system/apps/node/ads-adm-api/src/clients/${target}.client.ts uses httpBatchLink at /trpc.` };
  }
  if (source === 'programs-api' && target === 'iam-api') {
    return { protocol: 'trpc', evidence: 'program-hub/apps/node/programs-api/src/services/iam-service-groups.client.ts uses httpBatchLink at /trpc.' };
  }
  if (source === 'sessions-api' && target === 'authz-api') {
    return { protocol: 'trpc', evidence: 'program-hub/apps/node/sessions-api/src/services/authz-capabilities-client.ts GETs /trpc/authz.capabilities. Using fetch does not make this REST.' };
  }
  if (target === 'infra:openfga') {
    return { protocol: 'rest', evidence: 'The declared OpenFGA HTTP API connection uses its REST transport.' };
  }
  return { protocol: 'unknown', evidence: 'This dependency has no verified application protocol annotation yet. HTTP alone does not establish REST.' };
}
