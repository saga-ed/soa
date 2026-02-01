import { describe, it, expect, beforeEach } from 'vitest';
import { Container } from 'inversify';
import type { MongoClient } from 'mongodb';
import { MONGO_CLIENT } from '@saga-ed/soa-db';
import type { IMongoConnMgr } from '@saga-ed/soa-db';
import { MockMongoProvider } from '@saga-ed/soa-db/mocks/mock-mongo-provider';
import type { ILogger, PinoLoggerConfig } from '@saga-ed/soa-logger';
import { PinoLogger } from '@saga-ed/soa-logger';
import { ExpressServer } from '@saga-ed/soa-api-core/express-server';
import { ControllerLoader } from '@saga-ed/soa-api-core/utils/controller-loader';
import type { ExpressServerConfig } from '@saga-ed/soa-api-core/express-server-schema';

describe('Inversify Container Configuration', () => {
    let container: Container;

    beforeEach(() => {
        // Arrange: Create fresh container for each test
        container = new Container();

        const loggerConfig: PinoLoggerConfig = {
            configType: 'PINO_LOGGER',
            level: 'info',
            isExpressContext: true,
            prettyPrint: true,
        };

        const expressConfig: ExpressServerConfig = {
            configType: 'EXPRESS_SERVER',
            port: 4000,
            logLevel: 'info',
            name: 'REST API Example',
            basePath: 'saga-soa',
        };

        container.bind<PinoLoggerConfig>('PinoLoggerConfig').toConstantValue(loggerConfig);
        container.bind<ILogger>('ILogger').to(PinoLogger).inSingletonScope();
        container.bind<ExpressServerConfig>('ExpressServerConfig').toConstantValue(expressConfig);

        container
            .bind<IMongoConnMgr>('IMongoConnMgr')
            .toDynamicValue(async () => {
                const provider = new MockMongoProvider('MockMongoDB');
                await provider.connect();
                return provider;
            })
            .inSingletonScope();

        container
            .bind<MongoClient>(MONGO_CLIENT)
            .toDynamicValue(async () => {
                const mgr = await container.getAsync<IMongoConnMgr>('IMongoConnMgr');
                return mgr.getClient();
            })
            .inSingletonScope();

        container.bind(ExpressServer).toSelf().inSingletonScope();
        container.bind(ControllerLoader).toSelf().inSingletonScope();
    });

    describe('Logger Configuration', () => {
        it('should bind PinoLoggerConfig', () => {
            // Act
            const config = container.get<PinoLoggerConfig>('PinoLoggerConfig');

            // Assert
            expect(config.configType).toBe('PINO_LOGGER');
            expect(config.level).toBe('info');
            expect(config.isExpressContext).toBe(true);
        });

        it('should bind ILogger to PinoLogger singleton', () => {
            // Act
            const logger1 = container.get<ILogger>('ILogger');
            const logger2 = container.get<ILogger>('ILogger');

            // Assert
            expect(logger1).toBeDefined();
            expect(logger1).toBe(logger2); // Singleton
        });
    });

    describe('Express Server Configuration', () => {
        it('should bind ExpressServerConfig', () => {
            // Act
            const config = container.get<ExpressServerConfig>('ExpressServerConfig');

            // Assert
            expect(config.configType).toBe('EXPRESS_SERVER');
            expect(config.port).toBe(4000);
            expect(config.name).toBe('REST API Example');
            expect(config.basePath).toBe('saga-soa');
        });

        it('should bind ExpressServer singleton', () => {
            // Act
            const server1 = container.get(ExpressServer);
            const server2 = container.get(ExpressServer);

            // Assert
            expect(server1).toBeDefined();
            expect(server1).toBe(server2); // Singleton
        });
    });

    describe('MongoDB Configuration', () => {
        it('should bind IMongoConnMgr with MockMongoProvider', async () => {
            // Act
            const mgr = await container.getAsync<IMongoConnMgr>('IMongoConnMgr');

            // Assert
            expect(mgr).toBeDefined();
            expect(mgr.getClient()).toBeDefined();
        });

        it('should bind IMongoConnMgr as singleton', async () => {
            // Act
            const mgr1 = await container.getAsync<IMongoConnMgr>('IMongoConnMgr');
            const mgr2 = await container.getAsync<IMongoConnMgr>('IMongoConnMgr');

            // Assert
            expect(mgr1).toBe(mgr2); // Singleton
        });

        it('should bind MongoClient from IMongoConnMgr', async () => {
            // Act
            const client = await container.getAsync<MongoClient>(MONGO_CLIENT);

            // Assert
            expect(client).toBeDefined();
        });

        it('should bind MongoClient as singleton', async () => {
            // Act
            const client1 = await container.getAsync<MongoClient>(MONGO_CLIENT);
            const client2 = await container.getAsync<MongoClient>(MONGO_CLIENT);

            // Assert
            expect(client1).toBe(client2); // Singleton
        });
    });

    describe('Utility Services', () => {
        it('should bind ControllerLoader', () => {
            // Act
            const loader = container.get(ControllerLoader);

            // Assert
            expect(loader).toBeDefined();
        });

        it('should bind ControllerLoader as singleton', () => {
            // Act
            const loader1 = container.get(ControllerLoader);
            const loader2 = container.get(ControllerLoader);

            // Assert
            expect(loader1).toBe(loader2); // Singleton
        });
    });
});
