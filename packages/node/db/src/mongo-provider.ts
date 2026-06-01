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
  private _connected = false;
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

    const maxRetries = 3;
    const baseDelayMs = 1000;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        this.client = await new MongoClient(uri, this.config.options).connect();
        this._connected = true;
        return;
      } catch (err) {
        this.client = null;
        this._connected = false;
        // The driver's own server selection (serverSelectionTimeoutMS,
        // default ~30s) already absorbs transient unavailability within a
        // single connect(). This loop adds coverage for connects that fail
        // fast and then recover (e.g. a brief DNS/RS-election blip at boot).
        // Auth/authz failures are NOT transient — retrying just burns
        // another full server-selection window, so fail fast on those.
        if (MongoProvider.isNonRetryableAuthError(err) || attempt === maxRetries) {
          throw err;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, baseDelayMs * Math.pow(2, attempt - 1)),
        );
      }
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
    this._connected = false;
  }

  /**
   * Whether connect() has succeeded and disconnect() hasn't run. This is a
   * cheap synchronous flag, not a live reachability check — the driver can
   * lose every server while this still reads true. For a real probe (e.g.
   * a readiness endpoint) use {@link ping}.
   */
  isConnected(): boolean {
    return this._connected;
  }

  /**
   * Real liveness probe: issues an ``admin.ping`` against the current
   * topology, confirming a server is reachable right now. Returns false
   * instead of throwing so it's safe to call from health checks.
   */
  async ping(): Promise<boolean> {
    if (!this.client) return false;
    try {
      await this.client.db().command({ ping: 1 });
      return true;
    } catch {
      return false;
    }
  }

  getClient(): MongoClient {
    if (!this.client) {
      throw new Error('MongoClient is not connected');
    }
    return this.client;
  }

  /**
   * MongoServerError auth/authz failures (AuthenticationFailed=18,
   * Unauthorized=13) won't fix themselves on retry.
   */
  private static isNonRetryableAuthError(err: unknown): boolean {
    const code = (err as { code?: number | string } | null)?.code;
    return code === 18 || code === 13 || code === '18' || code === '13';
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
