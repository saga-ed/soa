import { Container } from 'inversify';
import type { MongoClient } from 'mongodb';
import { MONGO_CLIENT } from '@hipponot/db';
import type { IMongoConnMgr } from '@hipponot/db';
import { MockMongoProvider } from '@hipponot/db/mocks/mock-mongo-provider';
import type { ILogger, PinoLoggerConfig } from '@hipponot/logger';
import { PinoLogger } from '@hipponot/logger';
import { ExpressServer } from '@hipponot/api-core/express-server';
import { ControllerLoader } from '@hipponot/api-core/utils/controller-loader';
import type { ExpressServerConfig } from '@hipponot/api-core/express-server-schema';

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
  port: Number(process.env.PORT) || 3000,
  logLevel: 'info',
  name: 'REST API Example',
  basePath: 'saga-soa', // Simplified basePath since controllers no longer include hardcoded prefix
};

container.bind<PinoLoggerConfig>('PinoLoggerConfig').toConstantValue(loggerConfig);
container.bind<ILogger>('ILogger').to(PinoLogger).inSingletonScope();

// Bind ExpressServer configuration
container.bind<ExpressServerConfig>('ExpressServerConfig').toConstantValue(expressConfig);

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

// Bind ControllerLoader
container.bind(ControllerLoader).toSelf().inSingletonScope();

export { container };
