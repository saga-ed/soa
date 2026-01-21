import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { IMongoConnMgr } from '../i-mongo-conn-mgr.js';

export class MockMongoProvider implements IMongoConnMgr {
  public readonly instanceName: string;
  private client: MongoClient | null = null;
  private mongoServer: MongoMemoryServer | null = null;

  constructor(instanceName: string = 'MockMongoDB') {
    this.instanceName = instanceName;
  }

  async connect(): Promise<void> {
    this.mongoServer = await MongoMemoryServer.create();
    const uri = this.mongoServer.getUri();
    this.client = new MongoClient(uri);
    await this.client.connect();
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
    if (this.mongoServer) {
      await this.mongoServer.stop();
      this.mongoServer = null;
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
}
