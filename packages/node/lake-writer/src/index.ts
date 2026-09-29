// @saga-ed/soa-lake-writer — shared library every Saga service uses to
// export pseudonymised snapshots of its own data to the SDS FERPA data
// lake's S3 landing zone. Library only: no CLI, no job runner. See the
// README for the compound-key invariant and a worked usage example.

export * from './pseudonymise.js';
export * from './school-year.js';
export * from './salt.js';
export * from './landing-path.js';
export * from './parquet-writer.js';
export * from './sink.js';
export * from './export.js';
export * from './dbt-render.js';
export * from './drift.js';
export * from './datasets/index.js';
