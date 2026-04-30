import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { injectable } from 'inversify';
import { MongoClient } from 'mongodb';
import type { MongoProviderConfig } from './mongo-provider-config.js';
import { IMongoConnMgr } from './i-mongo-conn-mgr.js';

@injectable()
export class MongoProvider implements IMongoConnMgr {
  public readonly instanceName: string;
  private client: MongoClient | null = null;
  private config: MongoProviderConfig;
  // Resolved CA path — either the caller-provided tlsCAFile, or a tmp path
  // we wrote tlsCAContent to. Computed once at construction so writes don't
  // happen on every connect() retry.
  private readonly resolvedCAFile: string | undefined;

  constructor(config: MongoProviderConfig) {
    this.config = config;
    this.instanceName = config.instanceName;
    this.resolvedCAFile = MongoProvider.resolveCAFile(config);
  }

  async connect(): Promise<void> {
    if (this.isConnected()) return;
    const uri = this._buildConnectionString();
    this.client = null;
    this.client = await new MongoClient(uri, this.config.options).connect();
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

  /**
   * Build a `mongodb://` connection string from the config.
   *
   * Shape:
   *   mongodb://[user:pass@]host1:port1,host2:port2,.../database?<query>
   *
   * Query parameters are added only when the corresponding config field is set.
   */
  _buildConnectionString(): string {
    const { hosts, database, username, password, replicaSet, authSource, tls } =
      this.config;

    const auth = username && password
      ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`
      : '';

    const hostList = hosts.join(',');

    const params = new URLSearchParams();
    if (replicaSet) params.set('replicaSet', replicaSet);
    if (authSource) params.set('authSource', authSource);
    if (tls) {
      params.set('tls', 'true');
      params.set('retryWrites', 'true');
      if (this.resolvedCAFile) params.set('tlsCAFile', this.resolvedCAFile);
    }

    const query = params.toString();
    const querySuffix = query ? `?${query}` : '';

    return `mongodb://${auth}${hostList}/${database}${querySuffix}`;
  }

  /**
   * Resolve the CA file path. If the caller passed `tlsCAFile`, use it. If
   * they passed `tlsCAContent` (PEM string from Secrets Manager), write it
   * to a deterministic tmp path keyed on instanceName and return that path.
   * If neither is set, return undefined (driver uses the system CA bundle).
   *
   * Throws if both `tlsCAFile` and `tlsCAContent` are set — the caller has
   * to pick one to avoid ambiguity.
   */
  private static resolveCAFile(config: MongoProviderConfig): string | undefined {
    const { tls, tlsCAFile, tlsCAContent, instanceName } = config;
    if (!tls) return undefined;
    if (tlsCAFile && tlsCAContent) {
      throw new Error(
        `MongoProviderConfig for ${instanceName} sets both tlsCAFile and tlsCAContent — pick one`,
      );
    }
    if (tlsCAFile) return tlsCAFile;
    if (tlsCAContent) {
      const safeName = instanceName.replace(/[^a-zA-Z0-9_-]/g, '_');
      const path = join(tmpdir(), `saga-mongodb-ca-${safeName}.pem`);
      writeFileSync(path, tlsCAContent, { mode: 0o400 });
      return path;
    }
    return undefined;
  }
}

export const MongoProviderFactory = Symbol('MongoProviderFactory');
export type MongoProviderFactory = (config: MongoProviderConfig) => MongoProvider;
