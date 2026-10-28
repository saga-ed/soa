import type { Relationship } from '../../../web/vishnu/src/lib/graph/types';

/** Reviewed source wiring, not a claim about deployed configuration or recent traffic.
 * Keep this catalog independent of the synthetic launcher (ports/env/credentials).
 * Review date: 2026-10-24. Conditional clients remain explicitly conditional.
 */
export interface Declaration {
  source: string;
  target: string;
  protocol: Relationship['protocol'];
  repo: string;
  path: string;
  condition?: string;
}
const clients = (source: string, targets: string[], repo: string, path: string): Declaration[] =>
  targets.map(target => ({ source, target, protocol: 'trpc', repo, path }));
export const declaredConnections: readonly Declaration[] = [
  ...clients(
    'saga_dash',
    [
      'iam-api',
      'sis-api',
      'programs-api',
      'scheduling-api',
      'sessions-api',
      'content-api',
      'transcripts-api',
      'insights-api',
      'ledger-api',
    ],
    'saga-dash',
    'packages/core/dash-data/src/trpc/clients.ts'
  ),
  {
    source: 'saga_dash',
    target: 'authz-api',
    protocol: 'trpc',
    repo: 'saga-dash',
    path: 'packages/core/dash-data/src/trpc/clients.ts',
    condition: 'When the authz endpoint is configured.',
  },
  ...clients(
    'saga_dash',
    ['ads-adm-api'],
    'saga-dash',
    'packages/web/pages/adm/src/lib/api/ads-client.ts'
  ),
  {
    source: 'coach',
    target: 'coach-api',
    protocol: 'graphql',
    repo: 'coach',
    path: 'apps/web/coach-web/src/lib/api/graphql.ts',
  },
  {
    source: 'coach',
    target: 'iam-api',
    protocol: 'mixed',
    repo: 'coach',
    path: 'apps/web/coach-web/src/lib/api/session.ts',
  },
  ...clients('coach', ['programs-api'], 'coach', 'apps/web/coach-web/src/lib/api/programs.ts'),
  {
    source: 'connectv3',
    target: 'connectv3-api',
    protocol: 'rest',
    repo: 'qboard',
    path: 'apps/web/connectv3/src/auth/auth-client.ts',
  },
  ...clients('connectv3', ['iam-api'], 'qboard', 'apps/web/connectv3/src/auth/iam-client.ts'),
  {
    source: 'connectv3',
    target: 'authz-api',
    protocol: 'trpc',
    repo: 'qboard',
    path: 'apps/web/connectv3/src/auth/iam-client.ts',
    condition: 'When VITE_AUTHZ_API_URL is configured; otherwise permissions use IAM.',
  },
  {
    source: 'connectv3',
    target: 'rtsm-api',
    protocol: undefined,
    repo: 'qboard',
    path: 'apps/web/connectv3/src/config.ts',
    condition:
      'Selected RTSM fleet or explicit bootstrap endpoint; exact transport is not annotated here.',
  },
  ...clients(
    'programs-api',
    ['iam-api'],
    'program-hub',
    'apps/node/programs-api/src/services/iam-service-groups.client.ts'
  ),
  ...clients(
    'sessions-api',
    ['authz-api'],
    'program-hub',
    'apps/node/sessions-api/src/services/authz-capabilities-client.ts'
  ),
  {
    source: 'sis-api',
    target: 'iam-api',
    protocol: 'mixed',
    repo: 'rostering',
    path: 'apps/node/sis-api/src/clients/iam.client.ts',
  },
  {
    source: 'ads-adm-api',
    target: 'iam-api',
    protocol: 'mixed',
    repo: 'student-data-system',
    path: 'apps/node/ads-adm-api/src/clients/iam-api.client.ts',
    condition:
      'REST token exchange depends on the service-token configuration; business client uses tRPC.',
  },
  ...clients(
    'ads-adm-api',
    ['sessions-api'],
    'student-data-system',
    'apps/node/ads-adm-api/src/clients/sessions-api.client.ts'
  ),
  ...clients(
    'ads-adm-api',
    ['programs-api'],
    'student-data-system',
    'apps/node/ads-adm-api/src/clients/programs-api.client.ts'
  ),
];
export const applicationLabels = new Map([
  ['coach', 'Coach'],
  ['connectv3', 'Connectv3'],
  ['saga_dash', 'Saga Dash'],
]);
