import { MongoClient } from 'mongodb';

export { MongoProvider } from './mongo-provider.js';
export { MongoProviderSchema } from './mongo-provider-config.js';
export type { MongoProviderConfig } from './mongo-provider-config.js';
export type { IMongoConnMgr } from './i-mongo-conn-mgr.js';
export const MONGO_CLIENT = Symbol.for('MongoClient');
export { MockMongoProvider } from './mocks/mock-mongo-provider.js';
export type MongoClientFactory = () => Promise<MongoClient>;
export const MONGO_CLIENT_FACTORY = Symbol.for('MongoClientFactory');
