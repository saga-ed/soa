// Pure comparison machinery, ported from student-data-system's
// apps/node/fixtures/src/__tests__/landing-schema-drift.test.ts, for
// catching the most common "declared in two places, only one updated"
// bug: a landing dataset's registry schema (this package) and its dbt
// `sources.yml` entry drift apart. Operates on already-parsed objects
// (no yaml dependency here) so callers own how they read the YAML file.

import type { LandingColumnType, LandingDataset } from './parquet-writer.js';

export interface DbtColumn {
  name: string;
  data_type?: string;
}

export interface DbtTable {
  name: string;
  columns?: DbtColumn[];
  external?: { partitions?: DbtColumn[] };
}

export interface DbtSourcesFile {
  sources: Array<{ name: string; tables: DbtTable[] }>;
}

export interface CompareRegistryToDbtSourcesOptions {
  /** The `sources: - name: <sourceName>` block to compare against. Defaults to `'landing'`. */
  sourceName?: string;
  /** sources.yml table names allowed to have no registry entry (e.g. a dim table with no source leg). */
  ignoreTables?: readonly string[];
}

export interface CompareRegistryToDbtSourcesResult {
  problems: string[];
}

type TypeCategory = 'string' | 'numeric' | 'boolean' | 'timestamp';

const COLUMN_TYPE_CATEGORY: Record<LandingColumnType, TypeCategory> = {
  string: 'string',
  double: 'numeric',
  int64: 'numeric',
  boolean: 'boolean',
  timestamp: 'timestamp',
};

const YML_DATA_TYPE_CATEGORY: Record<string, TypeCategory> = {
  string: 'string',
  double: 'numeric',
  bigint: 'numeric',
  boolean: 'boolean',
  timestamp: 'timestamp',
};

/**
 * Compare a registry of `LandingDataset`s against a parsed
 * `dbt/models/sources.yml` object. Reports (never throws) every
 * mismatch found:
 *
 *   - a registry dataset with no matching sources.yml table
 *   - a sources.yml table with no matching registry dataset (unless
 *     named in `ignoreTables`)
 *   - column-set inequality (sources.yml `columns` + `external.partitions`
 *     merged, vs. the registry schema's column names)
 *   - a sources.yml column name appearing in both `columns` and
 *     `external.partitions`
 *   - a registry dataset's declared `fingerprint` columns missing from
 *     its own schema
 *   - coarse type-category disagreement (string / numeric / boolean /
 *     timestamp) between the registry schema and sources.yml
 */
export function compareRegistryToDbtSources(
  registry: Record<string, LandingDataset<Record<string, unknown>>>,
  sourcesYml: DbtSourcesFile,
  opts: CompareRegistryToDbtSourcesOptions = {}
): CompareRegistryToDbtSourcesResult {
  const sourceName = opts.sourceName ?? 'landing';
  const ignoreTables = new Set(opts.ignoreTables ?? []);
  const problems: string[] = [];

  const source = sourcesYml.sources.find(s => s.name === sourceName);
  if (!source) {
    problems.push(`no source named "${sourceName}" in the given sources.yml object`);
    return { problems };
  }
  const tablesByName = new Map(source.tables.map(t => [t.name, t]));

  for (const name of Object.keys(registry)) {
    if (!tablesByName.has(name)) {
      problems.push(`registry dataset "${name}" has no sources.yml table`);
    }
  }
  for (const name of tablesByName.keys()) {
    if (!(name in registry) && !ignoreTables.has(name)) {
      problems.push(`sources.yml table "${name}" has no registry entry`);
    }
  }

  for (const [name, dataset] of Object.entries(registry)) {
    const table = tablesByName.get(name);
    if (!table) continue; // already reported above

    const ymlCols = new Set<string>([
      ...(table.columns ?? []).map(c => c.name),
      ...(table.external?.partitions ?? []).map(p => p.name),
    ]);
    const registryCols = new Set(dataset.columnNames);

    const onlyInYml = [...ymlCols].filter(c => !registryCols.has(c));
    const onlyInRegistry = [...registryCols].filter(c => !ymlCols.has(c));
    if (onlyInYml.length > 0) {
      problems.push(
        `${name}: sources.yml has columns not in the registry schema: ${onlyInYml.join(', ')}`
      );
    }
    if (onlyInRegistry.length > 0) {
      problems.push(
        `${name}: registry schema has columns not in sources.yml: ${onlyInRegistry.join(', ')}`
      );
    }

    const colSet = new Set((table.columns ?? []).map(c => c.name));
    const partitionNames = (table.external?.partitions ?? []).map(p => p.name);
    const overlap = partitionNames.filter(p => colSet.has(p));
    if (overlap.length > 0) {
      problems.push(`${name}: sources.yml columns and partitions overlap: ${overlap.join(', ')}`);
    }

    const missingFingerprint = dataset.fingerprint.filter(c => !registryCols.has(c));
    if (missingFingerprint.length > 0) {
      problems.push(
        `${name}: registry schema is missing its own fingerprint columns: ${missingFingerprint.join(', ')}`
      );
    }

    const ymlCategories = new Map<string, TypeCategory>();
    for (const c of [...(table.columns ?? []), ...(table.external?.partitions ?? [])]) {
      if (!c.data_type) continue;
      const cat = YML_DATA_TYPE_CATEGORY[c.data_type.toLowerCase()];
      if (!cat) {
        problems.push(
          `${name}: sources.yml column "${c.name}" has unknown data_type "${c.data_type}"`
        );
        continue;
      }
      ymlCategories.set(c.name, cat);
    }
    for (const col of dataset.columns) {
      const registryCategory = COLUMN_TYPE_CATEGORY[col.type];
      const ymlCategory = ymlCategories.get(col.name);
      if (ymlCategory && ymlCategory !== registryCategory) {
        problems.push(
          `${name}: type-category drift on "${col.name}": registry=${registryCategory} (${col.type}) ` +
            `<-> sources.yml=${ymlCategory}`
        );
      }
    }
  }

  return { problems };
}
