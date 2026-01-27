import { MongoClient } from 'mongodb';

export interface IMongoConnMgr {
  readonly instanceName: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  getClient(): MongoClient;
}
