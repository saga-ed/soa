export { PostgresProvider } from './postgres-provider.js';
export { PostgresProviderSchema } from './postgres-provider-config.js';
export type { PostgresProviderConfig } from './postgres-provider-config.js';
export { loadPostgresConfigFromAws } from './aws-postgres-loader.js';
export type { LoadPostgresConfigParams } from './aws-postgres-loader.js';

export const POSTGRES_PROVIDER = Symbol.for('PostgresProvider');
