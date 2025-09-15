import 'reflect-metadata';
import { Container }                      from 'inversify';
import { PinoLogger }                     from '@hipponot/soa-logger';
import { MongoProvider }                  from '@hipponot/soa-db';
import { ExpressServer }                  from '@hipponot/soa-api-core/express-server';
import { TRPCServer }                     from '@hipponot/soa-api-core/trpc-server';
import { ControllerLoader }               from '@hipponot/soa-api-core/utils/controller-loader';
import type { ILogger, PinoLoggerConfig } from '@hipponot/soa-logger';
import type { IMongoConnMgr }             from '@hipponot/soa-db';
import type { TRPCServerConfig }          from '@hipponot/soa-api-core/trpc-server-schema';
import type { ExpressServerConfig }       from '@hipponot/soa-api-core/express-server-schema';

// Import pubsub server components
import { PubSubService, EventService, ChannelService, InMemoryAdapter, TYPES } from '@hipponot/soa-pubsub-server';
import type { PubSubAdapter }             from '@hipponot/soa-pubsub-server';

export const container = new Container();

// Logger configuration
const loggerConfig: PinoLoggerConfig = {
  configType: 'PINO_LOGGER',
  level: 'info',
  isExpressContext: true,
  prettyPrint: true,
};

// Express Server configuration
const expressConfig: ExpressServerConfig = {
  configType: 'EXPRESS_SERVER',
  port: Number(process.env.PORT) || 5000,
  logLevel: 'info',
  name: 'Example tRPC API',
  basePath: '/saga-soa/v1', // Add basePath like other examples
};

// tRPC Server configuration
const trpcConfig: TRPCServerConfig = {
  configType: 'TRPC_SERVER',
  name: 'Example tRPC API',
  basePath: '/saga-soa/v1/trpc',
  contextFactory: async () => ({}),
};

// Bind logger
container.bind<PinoLoggerConfig>('PinoLoggerConfig').toConstantValue(loggerConfig);
container.bind<ILogger>('ILogger').to(PinoLogger).inSingletonScope();
container.bind(TYPES.Logger).to(PinoLogger).inSingletonScope();

// Bind ExpressServer configuration
container.bind<ExpressServerConfig>('ExpressServerConfig').toConstantValue(expressConfig);

// Bind database
container.bind<IMongoConnMgr>('IMongoConnMgr').to(MongoProvider);

// Bind ExpressServer
container.bind(ExpressServer).toSelf().inSingletonScope();

// Bind tRPC Server
container.bind<TRPCServerConfig>('TRPCServerConfig').toConstantValue(trpcConfig);
container.bind(TRPCServer).toSelf().inSingletonScope();

// Bind ControllerLoader
container.bind(ControllerLoader).toSelf().inSingletonScope();

// Bind PubSub Server components (order matters for dependencies)
container.bind<PubSubAdapter>(TYPES.PubSubAdapter).to(InMemoryAdapter).inSingletonScope();
container.bind(TYPES.EventService).to(EventService).inSingletonScope();
container.bind(TYPES.ChannelService).to(ChannelService).inSingletonScope();
container.bind('PubSubService').to(PubSubService).inSingletonScope();
