import { Container } from 'inversify';
import type { MongoClient } from 'mongodb';
import { MONGO_CLIENT } from '@hipponot/soa-db';
import type { IMongoConnMgr } from '@hipponot/soa-db';
import { MockMongoProvider } from '@hipponot/soa-db/mocks/mock-mongo-provider';
import type { ILogger, PinoLoggerConfig } from '@hipponot/soa-logger';
import { PinoLogger } from '@hipponot/soa-logger';
import { ExpressServer } from '@hipponot/soa-api-core/express-server';
import { TGQLServer } from '@hipponot/soa-api-core/tgql-server';
import { ControllerLoader } from '@hipponot/soa-api-core/utils/controller-loader';
import type { ExpressServerConfig } from '@hipponot/soa-api-core/express-server-schema';
import type { TGQLServerConfig } from '@hipponot/soa-api-core/tgql-server-schema';

const container = new Container();

// Example config for PinoLogger
const loggerConfig: PinoLoggerConfig = {
  configType: 'PINO_LOGGER',
  level: 'info',
  isExpressContext: true,
  prettyPrint: true,
};

// Express Server configuration
const expressConfig: ExpressServerConfig = {
  configType: 'EXPRESS_SERVER',
  port: Number(process.env.PORT) || 4002,
  logLevel: 'info',
  name: 'Example GraphQL API',
  basePath: '/saga-soa/v1', // All routes will be prefixed with this base path
};

// GraphQL Server configuration
const gqlConfig: TGQLServerConfig = {
  configType: 'TGQL_SERVER',
  mountPoint: '/graphql', // Will be mounted at /saga-soa/v1/graphql
  logLevel: 'info',
  name: 'GraphQL API',
  enablePlayground: true, // Enable GraphQL playground
  playgroundPath: '/playground', // Optional: custom playground path
  emitSchema: true, // Enable schema emission
  schemaDir: './generated', // Directory for generated schema files
};

container.bind<PinoLoggerConfig>('PinoLoggerConfig').toConstantValue(loggerConfig);
container.bind<ILogger>('ILogger').to(PinoLogger).inSingletonScope();

// Bind ExpressServer configuration
container.bind<ExpressServerConfig>('ExpressServerConfig').toConstantValue(expressConfig);

// Bind GraphQL Server configuration
container.bind<TGQLServerConfig>('TGQLServerConfig').toConstantValue(gqlConfig);

// Bind MongoProvider to IMongoConnMgr using async factory (toDynamicValue, Inversify v6.x)
container
  .bind<IMongoConnMgr>('IMongoConnMgr')
  .toDynamicValue(async () => {
    const provider = new MockMongoProvider('MockMongoDB');
    await provider.connect();
    return provider;
  })
  .inSingletonScope();

// Bind MongoClient to an async factory that returns the connected client
container
  .bind<MongoClient>(MONGO_CLIENT)
  .toDynamicValue(async () => {
    const mgr = await container.getAsync<IMongoConnMgr>('IMongoConnMgr');
    return mgr.getClient();
  })
  .inSingletonScope();

container.bind(ExpressServer).toSelf().inSingletonScope();
container.bind(TGQLServer).toSelf().inSingletonScope();

// Bind ControllerLoader
container.bind(ControllerLoader).toSelf().inSingletonScope();

export { container };
