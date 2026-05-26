import 'reflect-metadata';
import { injectable } from 'inversify';
import { Pool, type PoolClient } from 'pg';
import type { PostgresProviderConfig } from './postgres-provider-config.js';

/**
 * Manages a single ``pg.Pool`` for one logical database. Provider is
 * ORM-agnostic — consumers wrap the pool with Prisma (``PrismaPg``),
 * Drizzle, or use it directly.
 *
 * Lifted from student-data-system/packages/node/ads-adm-db with the
 * Prisma coupling removed so this package stays a thin postgres-only
 * library. Consumers that want Prisma adapt the pool themselves:
 *
 *   const provider = new PostgresProvider(config);
 *   await provider.connect();
 *   const adapter = new PrismaPg(provider.getPool());
 *   const client = new PrismaClient({ adapter });
 *
 * Connection failures retry with exponential backoff (3 attempts, 1s
 * base) — matches the original implementation.
 */
@injectable()
export class PostgresProvider {
  public readonly instanceName: string;
  private pool: Pool | null = null;
  private _isConnected = false;

  constructor(private readonly config: PostgresProviderConfig) {
    this.instanceName = config.instanceName;
  }

  async connect(): Promise<void> {
    if (this._isConnected) return;

    const maxRetries = 3;
    const baseDelayMs = 1000;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        this.pool = new Pool({
          connectionString: this.buildConnectionString(),
          max: this.config.poolSize,
          idleTimeoutMillis: this.config.idleTimeoutMs,
          connectionTimeoutMillis: this.config.connectionTimeoutMs,
        });

        if (this.config.statementTimeoutMs > 0 || this.config.lockTimeoutMs > 0) {
          this.pool.on('connect', (client: PoolClient) => {
            if (this.config.statementTimeoutMs > 0) {
              client.query(`SET statement_timeout = ${this.config.statementTimeoutMs}`);
            }
            if (this.config.lockTimeoutMs > 0) {
              client.query(`SET lock_timeout = ${this.config.lockTimeoutMs}`);
            }
          });
        }

        // Validate by acquiring + releasing one connection. We do this
        // rather than relying on Pool's lazy connect so a bad
        // host/credential fails fast at connect() rather than on the
        // first query.
        const probe = await this.pool.connect();
        probe.release();

        this._isConnected = true;
        return;
      } catch (err) {
        if (this.pool) {
          await this.pool.end().catch(() => {});
          this.pool = null;
        }
        if (attempt === maxRetries) throw err;
        await new Promise((resolve) =>
          setTimeout(resolve, baseDelayMs * Math.pow(2, attempt - 1)),
        );
      }
    }
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
    this._isConnected = false;
  }

  isConnected(): boolean {
    return this._isConnected;
  }

  /** Returns the underlying ``Pool``. Throws if not connected. */
  getPool(): Pool {
    if (!this.pool) {
      throw new Error('PostgresProvider is not connected. Call connect() first.');
    }
    return this.pool;
  }

  /** Build the postgres:// connection string from config. */
  private buildConnectionString(): string {
    const { host, port, database, username, password, ssl } = this.config;
    const auth = `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`;
    const sslParam = ssl ? '?sslmode=require' : '';
    return `postgresql://${auth}${host}:${port}/${database}${sslParam}`;
  }
}
