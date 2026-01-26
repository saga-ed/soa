import 'reflect-metadata';
import { Container } from 'inversify';
import { IMongoConnMgr } from '../i-mongo-conn-mgr.js';
import { MockMongoProvider } from '../mocks/mock-mongo-provider.js';
import { IConfigManager } from '@saga-ed/soa-config';
import { MockConfigManager } from '@saga-ed/soa-config/mocks/mock-config-manager.js';
import { MongoProviderSchema } from '../mongo-provider-config.js';
import type { MongoProviderConfig } from '../mongo-provider-config.js';
import { z } from 'zod';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('MockMongoProvider (Inversify Factory with MockConfigManager)', () => {
  const MOCK_INSTANCE_NAME = 'MockMongoDB';
  let container: Container;
  let mockConfig: MongoProviderConfig;

  beforeEach(() => {
    container = new Container();
    // Provide a valid mock config directly
    mockConfig = {
      configType: 'MONGO',
      instanceName: MOCK_INSTANCE_NAME,
      host: 'localhost',
      port: 27017,
      database: 'testdb',
      username: 'user',
      password: 'pass',
      options: {},
    };
    // Bind the factory for the mock provider
    container
      .bind<IMongoConnMgr>(MockMongoProvider)
      .toDynamicValue(() => new MockMongoProvider(mockConfig.instanceName))
      .whenTargetNamed(MOCK_INSTANCE_NAME);
  });

  afterEach(async () => {
    container.unbindAll();
  });

  it('should connect, check isConnected, getClient, and disconnect', async () => {
    const provider = container.getNamed<IMongoConnMgr>(MockMongoProvider, MOCK_INSTANCE_NAME);
    expect(provider.isConnected()).toBe(false);
    await provider.connect();
    expect(provider.isConnected()).toBe(true);
    const client = provider.getClient();
    expect(client).toBeDefined();
    await provider.disconnect();
    expect(provider.isConnected()).toBe(false);
  });

  it('should throw if getClient is called before connect', () => {
    const provider = container.getNamed<IMongoConnMgr>(MockMongoProvider, MOCK_INSTANCE_NAME);
    expect(() => provider.getClient()).toThrow('MongoClient is not connected');
  });
});
