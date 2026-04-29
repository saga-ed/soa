/**
 * Shared flag definitions reused by every mesh-fixture command.
 *
 * Commands import from here to avoid redefining the same --porcelain /
 * --output-json / service-URL flags in every file. The set split into two
 * buckets:
 *
 *   baseFlags      — present on every command (output shape + mesh URLs)
 *   authFlags      — additional dev-login flags (iam:/pgm:/ads: commands that
 *                    talk to services authenticated by the iam_session cookie)
 */

import { Flags } from '@oclif/core';

export const baseFlags = {
  porcelain: Flags.boolean({
    description: 'machine-readable output; no color, minimal noise',
    default: false,
  }),
  'output-json': Flags.boolean({
    description: 'emit structured JSON on stdout instead of human-readable text',
    default: false,
  }),
  'iam-url': Flags.string({
    description: 'override rostering iam-api base URL',
    default: process.env.IAM_API_URL ?? 'http://localhost:3000',
  }),
  'programs-url': Flags.string({
    description: 'override program-hub programs-api base URL',
    default: process.env.PROGRAMS_API_URL ?? 'http://localhost:3006',
  }),
  'scheduling-url': Flags.string({
    description: 'override program-hub scheduling-api base URL',
    default: process.env.SCHEDULING_API_URL ?? 'http://localhost:3008',
  }),
  'ads-adm-url': Flags.string({
    description: 'override SDS ads-adm-api base URL',
    default: process.env.ADS_ADM_URL ?? 'http://localhost:5005',
  }),
};

/**
 * Fixture-admin email used for devLogin against iam-api (iam:/pgm:/ads:
 * commands). Falls back to SAGA_MESH_ADMIN_EMAIL then the "demo-tutor"
 * convention. Ignored when iam-api runs with AUTH_AUTHENABLED=false but
 * kept for forward compat.
 */
export const asFlag = Flags.string({
  description: 'fixture-admin email for devLogin (ignored when AUTH_ENABLED=false)',
  default: process.env.SAGA_MESH_ADMIN_EMAIL ?? 'demo-tutor@fixture.test',
});

/**
 * Source namespace for iam slug-dedup / slug-to-UUID lookup. Every object
 * created by the CLI is stamped with source=demo (default) + sourceId=<slug>.
 */
export const sourceFlag = Flags.string({
  description: 'dedup / slug-lookup namespace',
  default: 'demo',
});

/**
 * Fixture identifier — passed through to every create/enroll command so
 * Phase 2 addCommand wiring can associate the run with a SnapshotMetadata row.
 */
export const fixtureIdFlag = Flags.string({
  description: 'fixture identifier',
  required: true,
});
