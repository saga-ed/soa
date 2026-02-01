import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Container } from 'inversify';
import { HelloRest } from '../../sectors/hello-rest.js';
import type { ILogger } from '@saga-ed/soa-logger';
import type { ExpressServerConfig } from '@saga-ed/soa-api-core/express-server-schema';

describe('HelloRest Controller', () => {
    let container: Container;
    let controller: HelloRest;
    let mockLogger: ILogger;
    let serverConfig: ExpressServerConfig;

    beforeEach(() => {
        // Arrange: Create test container with mocked dependencies
        container = new Container();

        mockLogger = {
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
            fatal: vi.fn(),
            trace: vi.fn(),
        } as unknown as ILogger;

        serverConfig = {
            configType: 'EXPRESS_SERVER',
            port: 4000,
            logLevel: 'info',
            name: 'Test API',
            basePath: 'test',
        };

        container.bind<ILogger>('ILogger').toConstantValue(mockLogger);
        container.bind<ExpressServerConfig>('ExpressServerConfig').toConstantValue(serverConfig);
        container.bind(HelloRest).toSelf();

        controller = container.get(HelloRest);
    });

    describe('constructor', () => {
        it('should initialize with correct sector name', () => {
            // Assert
            expect(controller.sectorName).toBe('hello');
        });

        it('should set logger from DI', () => {
            // Assert
            expect(controller['logger']).toBe(mockLogger);
        });
    });

    describe('testRoute', () => {
        it('should return Hello message', () => {
            // Act
            const result = controller.testRoute();

            // Assert
            expect(result).toBe('Hello');
        });

        it('should log info message when route is hit', () => {
            // Act
            controller.testRoute();

            // Assert
            expect(mockLogger.info).toHaveBeenCalledWith('Hello route hit');
        });
    });

    describe('init', () => {
        it('should complete without error', async () => {
            // Act & Assert
            await expect(controller.init()).resolves.toBeUndefined();
        });
    });
});
