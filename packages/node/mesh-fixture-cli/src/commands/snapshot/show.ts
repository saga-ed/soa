/**
 * snapshot:show — cross-service view of a fixture's FixtureMetadata rows.
 *
 * Queries `fixture.registry.get` in parallel on iam-api + programs-api +
 * scheduling-api + ads-adm-api, merges the results, and prints a human /
 * porcelain / JSON summary. Services that don't have the fixture are
 * listed explicitly so the reader knows where the gap is.
 *
 * Design notes:
 *   * Command history across services is merged and sorted by timestamp
 *     ascending, so the oldest command prints first and the most recent
 *     prints last (matches "audit log, most recent last" convention).
 *   * Description is picked from the first service that has one — in
 *     practice they should all agree, but merging by concat would be noisy.
 *   * Top-level createdAt / lastUpdated are min/max across services — the
 *     fixture was "born" when the first service saw it and "last updated"
 *     when the most recent registry write landed.
 */

import { Args } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import {
  getRegistry,
  type CommandInfo,
  type FixtureMetadata,
  type RegistryService,
} from '../../lib/registry.js';

const SERVICES: readonly RegistryService[] = [
  'iam',
  'programs',
  'scheduling',
  'ads',
];

const SERVICE_LABELS: Record<RegistryService, string> = {
  iam: 'Rostering artifacts (iam-api)',
  programs: 'Programs artifacts (programs-api)',
  scheduling: 'Scheduling artifacts (scheduling-api)',
  ads: 'ADS/ADM artifacts (ads-adm-api)',
};

interface ServiceView {
  service: RegistryService;
  metadata: FixtureMetadata | null;
  error: string | null;
}

interface MergedView {
  id: string;
  createdAt: string | null;
  lastUpdated: string | null;
  description: string | null;
  services: Record<RegistryService, FixtureMetadata | null>;
  serviceErrors: Record<RegistryService, string | null>;
  commandHistory: CommandInfo[];
  presentIn: RegistryService[];
  missingIn: RegistryService[];
}

function mergeViews(id: string, views: ServiceView[]): MergedView {
  const services = {} as Record<RegistryService, FixtureMetadata | null>;
  const serviceErrors = {} as Record<RegistryService, string | null>;
  const commandHistory: CommandInfo[] = [];
  const presentIn: RegistryService[] = [];
  const missingIn: RegistryService[] = [];
  let createdAt: string | null = null;
  let lastUpdated: string | null = null;
  let description: string | null = null;

  for (const v of views) {
    services[v.service] = v.metadata;
    serviceErrors[v.service] = v.error;
    if (v.metadata) {
      presentIn.push(v.service);
      if (description === null && v.metadata.description) {
        description = v.metadata.description;
      }
      if (createdAt === null || v.metadata.createdAt < createdAt) {
        createdAt = v.metadata.createdAt;
      }
      if (lastUpdated === null || v.metadata.lastUpdated > lastUpdated) {
        lastUpdated = v.metadata.lastUpdated;
      }
      for (const c of v.metadata.commandHistory ?? []) {
        commandHistory.push(c);
      }
    } else if (v.error === null) {
      missingIn.push(v.service);
    }
  }

  commandHistory.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return {
    id,
    createdAt,
    lastUpdated,
    description,
    services,
    serviceErrors,
    commandHistory,
    presentIn,
    missingIn,
  };
}

export default class SnapshotShow extends BaseCommand {
  static description =
    'Show a fixture\'s merged registry across iam-api / programs-api / scheduling-api / ads-adm-api.';

  static args = {
    'fixture-id': Args.string({
      description: 'fixture identifier to display',
      required: true,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(SnapshotShow);
    const id = args['fixture-id'];

    // Fetch across all 4 services in parallel. Distinguish NOT_FOUND (legit
    // absence) from transport errors (network / 500) so we can still print
    // a useful summary when one service is flaky.
    const views: ServiceView[] = await Promise.all(
      SERVICES.map(async (service): Promise<ServiceView> => {
        try {
          const metadata = await getRegistry(service, id, flags);
          return { service, metadata, error: null };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { service, metadata: null, error: msg };
        }
      }),
    );

    const merged = mergeViews(id, views);

    if (flags['output-json']) {
      this.log(JSON.stringify(merged, null, 2));
      return;
    }

    if (flags.porcelain) {
      // Flat key=value lines. One line per service presence flag; one line
      // per merged createdAt / lastUpdated / description; one
      // command=<name>:<timestamp> line per history entry.
      this.log(`id=${merged.id}`);
      if (merged.createdAt) this.log(`createdAt=${merged.createdAt}`);
      if (merged.lastUpdated) this.log(`lastUpdated=${merged.lastUpdated}`);
      if (merged.description) this.log(`description=${merged.description}`);
      this.log(`presentIn=${merged.presentIn.join(',')}`);
      if (merged.missingIn.length) this.log(`missingIn=${merged.missingIn.join(',')}`);
      for (const [service, err] of Object.entries(merged.serviceErrors)) {
        if (err) this.log(`error_${service}=${err}`);
      }
      for (const c of merged.commandHistory) {
        this.log(`command=${c.command}\t${c.timestamp}`);
      }
      return;
    }

    // Human-readable output.
    this.log(`Fixture: ${merged.id}`);
    if (merged.createdAt) this.log(`  created:     ${merged.createdAt}`);
    if (merged.lastUpdated) this.log(`  lastUpdated: ${merged.lastUpdated}`);
    if (merged.description) this.log(`  description: ${merged.description}`);
    if (merged.presentIn.length === 0) {
      this.log(`  (fixture not found in any of: ${SERVICES.join(', ')})`);
      return;
    }
    this.log(`  present in:  ${merged.presentIn.join(', ')}`);
    if (merged.missingIn.length) {
      this.log(`  missing in:  ${merged.missingIn.join(', ')}`);
    }
    for (const [service, err] of Object.entries(merged.serviceErrors)) {
      if (err) this.log(`  error (${service}): ${err}`);
    }

    // Per-service artifact subsections.
    for (const service of SERVICES) {
      const md = merged.services[service];
      if (!md) continue;
      this.log('');
      this.log(SERVICE_LABELS[service] + ':');
      const artifacts = md.artifacts ?? {};
      const keys = Object.keys(artifacts);
      if (keys.length === 0) {
        this.log('  (none)');
      } else {
        for (const k of keys) {
          const v = artifacts[k];
          if (Array.isArray(v)) {
            this.log(`  ${k}: ${v.length} ${v.length === 1 ? 'row' : 'rows'}`);
          } else {
            this.log(`  ${k}: ${JSON.stringify(v)}`);
          }
        }
      }
    }

    // Command history — oldest first, newest last.
    if (merged.commandHistory.length) {
      this.log('');
      this.log(`Command history (${merged.commandHistory.length} entries, oldest first):`);
      for (const c of merged.commandHistory) {
        this.log(`  ${c.timestamp}  ${c.command}`);
      }
    }
  }
}
