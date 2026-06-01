export { PostgresProvider } from './postgres-provider.js';
export { PostgresProviderSchema } from './postgres-provider-config.js';
export type { PostgresProviderConfig } from './postgres-provider-config.js';
export {
  loadPostgresConfigFromAws,
  iamHostSsmPath,
  iamPortSsmPath,
  devSecretName,
} from './aws-postgres-loader.js';
export type {
  LoadPostgresConfigParams,
  PostgresPoolConfig,
  PostgresSslConfig,
} from './aws-postgres-loader.js';

export const POSTGRES_PROVIDER = Symbol.for('PostgresProvider');
