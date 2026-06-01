import { MongoClient } from 'mongodb';

export interface IMongoConnMgr {
  readonly instanceName: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** Cheap sync flag: connect() succeeded and disconnect() hasn't run. */
  isConnected(): boolean;
  /**
   * Optional real liveness probe (admin.ping). Returns false rather than
   * throwing. Optional so existing implementers aren't forced to add it.
   */
  ping?(): Promise<boolean>;
  getClient(): MongoClient;
}
