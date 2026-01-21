import { injectable } from 'inversify';
import { MongoClient } from 'mongodb';
import type { MongoProviderConfig } from './mongo-provider-config.js';
import { IMongoConnMgr } from './i-mongo-conn-mgr.js';

@injectable()
export class MongoProvider implements IMongoConnMgr {
  public readonly instanceName: string;
  private client: MongoClient | null = null;
  private config: MongoProviderConfig;

  constructor(config: MongoProviderConfig) {
    this.config = config;
    this.instanceName = config.instanceName;
  }

  async connect(): Promise<void> {
    if (this.isConnected()) return;
    const uri = this._buildConnectionString();
    this.client = new MongoClient(uri, this.config.options);
    await this.client.connect();
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
  }

  isConnected(): boolean {
    return !!this.client && !(this.client as any).closed;
  }

  getClient(): MongoClient {
    if (!this.client) {
      throw new Error('MongoClient is not connected');
    }
    return this.client;
  }

  private _buildConnectionString(): string {
    const { host, port, database, username, password } = this.config;
    let auth = '';
    if (username && password) {
      auth = `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`;
    }
    return `mongodb://${auth}${host}:${port}/${database}`;
  }
}

export const MongoProviderFactory = Symbol('MongoProviderFactory');
export type MongoProviderFactory = (config: MongoProviderConfig) => MongoProvider;
