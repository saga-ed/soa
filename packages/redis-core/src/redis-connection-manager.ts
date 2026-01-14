import { createClient } from 'redis';
import { inject, injectable } from 'inversify';
import { ensureError } from '@saga-ed/soa-api-util';
import type { ILogger } from '@saga-ed/soa-logger';

export interface RedisConfig {
  url: string;
  username: string;
  password: string;
  tls: boolean;
}

@injectable()
export class RedisConnectionManager {
  private readonly CACHE_TTL = 60 * 10; // 10 minutes
  private readonly DEFAULT_REFRESH_THROTTLE = 1000; // 1 second

  private client: ReturnType<typeof createClient> | undefined;
  private isConnected = false;

  constructor(
    @inject('RedisConfig') private readonly redisConfig: RedisConfig,
    @inject('ILogger') private readonly logger: ILogger
  ) {}

  public async initialize(): Promise<void> {
    if (this.isConnected) return;

    try {
      const { url, username, password, tls } = this.redisConfig;
      // https://volito.digital/using-iam-authentication-for-redis-on-aws-a-comprehensive-guide-with-code-examples/
      // this.client = new Redis({
      //   host: url,
      //   port: 6379,
      //   tls: {}, // Enables TLS
      //   username,
      //   password,
      // });
      //https://github.com/redis/node-redis/discussions/2768#discussioncomment-9649686
      if (tls) {
        this.client = createClient({
          // url: `redis://${url}:6379`,
          // username: "IAM_ROLE",
          // password: "arn:aws:iam::531314149529:role/instance-roles/app-instance-iam-dev",
          socket: {
            host: url,
            port: 6379,
            tls: true,
            rejectUnauthorized: false,
          },
          username,
          password,
        });
      } else {
        this.client = createClient({
          url: `redis://${url}:6379`,
          username,
          password,
        });
      }
      this.client.on('error', (err) => this.logger.error('Redis Client Error:', err));
      this.client.on('connect', () => {
        this.logger.info('Redis Client Connected');
        this.isConnected = true;
      });

      await this.client.connect();
      const test = await this.client.get('saga_api::test');
      this.logger.info('client initialized:', { test });
    } catch (error) {
      this.logger.error('Failed to initialize Redis client:', ensureError(error));
      throw error;
    }
  }

  private async handleOperation<T>(operation: (client: ReturnType<typeof createClient>) => Promise<T>, errorMessage: string): Promise<T | null> {
    try {
      if (!this.client) {
        throw new Error('Redis client not initialized');
      }
      return await operation(this.client);
    } catch (error) {
      this.logger.error(`${errorMessage}:`, ensureError(error));
      return null;
    }
  }

  public async get<T>(key: string): Promise<T | null> {
    return this.handleOperation(async (client) => {
      const value = await client.get(key);
      return value ? JSON.parse(value) as T : null;
    }, `Error getting Redis key ${key}`);
  }

  public async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    await this.handleOperation(async (client) => {
      const serialized_value = JSON.stringify(value);
      await client.setEx(key, ttlSeconds ?? this.CACHE_TTL, serialized_value);
    }, `Error setting Redis key ${key}`);
  }

  public async delete(key: string): Promise<void> {
    await this.handleOperation((client) => client.del(key), `Error deleting Redis key ${key}`);
  }

  /**
   * Delete multiple Redis keys in a single operation.
   * More efficient than calling delete() multiple times.
   *
   * @param keys - Array of keys to delete
   * @returns Number of keys that were deleted (keys that existed)
   */
  public async mdel(keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    return await this.handleOperation(async (client) => {
      // Redis DEL command accepts multiple keys and is atomic
      const deleted_count = await client.del(keys);
      return deleted_count;
    }, 'Error deleting multiple Redis keys') ?? 0;
  }

  public async disconnect(): Promise<void> {
    if (this.isConnected) {
      if (this.client) await this.client.quit();
      this.isConnected = false;
      this.logger.info('Redis Client Disconnected');
    }
  }

  public async refresh_cache<T>(
    cache_key: string,
    operation: () => Promise<T>,
    refresh_throttle_ms = 0,
  ): Promise<T> {
    if (refresh_throttle_ms > 0) {
      const refresh_key = `${cache_key}_refresh`;
      const last_refresh = await this.get<number>(refresh_key);

      // If the last refresh was less than the refresh throttle, just return the cached value without executing the operation
      if (last_refresh != null) {
        const cached_result = await this.get<T>(cache_key);
        if (cached_result) return cached_result;
      }

      await this.set(refresh_key, Date.now(), refresh_throttle_ms);
    }

    const result = await operation();
    await this.set(cache_key, result, this.CACHE_TTL);
    return result;
  }

  public async cached_call<T>(
    cache_key: string,
    operation: () => Promise<T>,
    refresh_cache = true,
    refresh_throttle_ms = this.DEFAULT_REFRESH_THROTTLE,
  ): Promise<T> {
    const start_time = performance.now();
    let is_cache_hit = false;

    try {
      // Try to get from cache first
      const cached_result = await this.get<T>(cache_key);
      if (cached_result) {
        if (refresh_cache) void this.refresh_cache(cache_key, operation, refresh_throttle_ms);
        is_cache_hit = true;
        return cached_result;
      }

      // If not in cache, refresh the cache
      return await this.refresh_cache(cache_key, operation);
    } catch (error) {
      this.logger.error(`Error with caching - ${cache_key}:`, ensureError(error));
      return await operation();
    } finally {
      const end_time = performance.now();
      this.logger.debug(`Cache ${is_cache_hit ? 'hit' : 'miss'} - ${cache_key}`);
      this.logger.debug(`${operation.name} execution time: ${end_time - start_time}ms`);
    }
  }

  public async sadd(key: string, member: string): Promise<void> {
    await this.handleOperation((client) => client.sAdd(key, JSON.stringify(member)), `Error adding member to Redis set ${key}`);
  }

  public async smembers<T>(key: string): Promise<T[]> {
    return await this.handleOperation(async (client) => {
      const members = await client.sMembers(key);
      return members.map(member => JSON.parse(member) as T);
    }, `Error getting Redis set members for ${key}`) ?? [];
  }

  public async srem(key: string, member: string): Promise<void> {
    await this.handleOperation((client) => client.sRem(key, JSON.stringify(member)), `Error removing member from Redis set ${key}`);
  }

  public async mget<T>(keys: string[]): Promise<Map<string, T>> {
    if (keys.length === 0) return new Map();

    return await this.handleOperation(async (client) => {
      const values = await client.mGet(keys);
      const result = new Map<string, T>();

      keys.forEach((key, index) => {
        const value = values[index];
        if (value != null) {
          result.set(key, JSON.parse(value) as T);
        }
      });
      return result;
    }, 'Error getting multiple Redis keys') ?? new Map();
  }

  public async mset(entries: Map<string, unknown>, ttlSeconds?: number): Promise<void> {
    if (entries.size === 0) return;

    await this.handleOperation(async (client) => {
      const ttl = ttlSeconds ?? this.CACHE_TTL;

      // Use pipeline for efficient bulk operations
      const pipeline = client.multi();

      for (const [key, value] of entries.entries()) {
        const serialized_value = JSON.stringify(value);
        pipeline.setEx(key, ttl, serialized_value);
      }

      await pipeline.exec();
    }, 'Error setting multiple Redis keys');
  }

  /**
   * Clear all Redis keys that match a given prefix.
   * Uses SCAN to efficiently find all matching keys and deletes them in batches.
   *
   * @param prefix - The prefix to match (e.g., "saga_api::cache::")
   * @returns Number of keys that were deleted
   */
  public async clearByPrefix(prefix: string): Promise<number> {
    return await this.handleOperation(async (client) => {
      const pattern = `${prefix}*`;
      const keys: string[] = [];
      let cursor = '0';

      // Use SCAN to efficiently iterate through all keys matching the pattern
      do {
        const result = await client.scan(cursor, {
          MATCH: pattern,
          COUNT: 100, // Process in batches of 100
        });
        cursor = result.cursor;
        keys.push(...result.keys);
      } while (cursor !== '0');

      if (keys.length === 0) {
        this.logger.debug(`No keys found matching prefix: ${prefix}`);
        return 0;
      }

      // Delete all matching keys in batches using the existing mdel method
      let deleted_count = 0;
      const batch_size = 1000; // Delete in batches to avoid overwhelming Redis

      for (let i = 0; i < keys.length; i += batch_size) {
        const batch = keys.slice(i, i + batch_size);
        const count = await this.mdel(batch);
        deleted_count += count;
      }

      this.logger.info(`Cleared ${deleted_count} keys with prefix: ${prefix}`);
      return deleted_count;
    }, `Error clearing Redis keys with prefix ${prefix}`) ?? 0;
  }
}