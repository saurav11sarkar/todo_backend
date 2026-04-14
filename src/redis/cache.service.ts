import { Inject, Injectable, Logger } from '@nestjs/common';
import type { RedisClientType } from 'redis';
import { REDIS_CLIENT } from './redis.constants';

/**
 * Reusable CacheService
 * ---------------------
 * Drop this file into any NestJS project that has a Redis client provider
 * (REDIS_CLIENT) and you instantly get fast, consistent caching everywhere.
 *
 * Usage (inside any service):
 *
 *   constructor(private readonly cache: CacheService) {}
 *
 *   async findAll(userId: string) {
 *     return this.cache.wrap(
 *       `todos:${userId}`,
 *       () => this.prisma.todo.findMany({ where: { userId } }),
 *       300, // TTL in seconds (optional, default 300)
 *     );
 *   }
 *
 *   async create(...) {
 *     // ... save to db
 *     await this.cache.invalidate(`todos:${userId}:*`);
 *   }
 */
@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);
  private readonly DEFAULT_TTL = 300; // 5 minutes

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: RedisClientType,
  ) {}

  /** Get a value from cache (auto-parsed). Returns null if missing. */
  async get<T = any>(key: string): Promise<T | null> {
    try {
      const raw = await this.redis.get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch (err) {
      this.logger.warn(`cache.get failed [${key}]: ${(err as Error).message}`);
      return null;
    }
  }

  /** Set a value in cache with TTL (seconds). */
  async set(key: string, value: any, ttl = this.DEFAULT_TTL): Promise<void> {
    try {
      await this.redis.setEx(key, ttl, JSON.stringify(value));
    } catch (err) {
      this.logger.warn(`cache.set failed [${key}]: ${(err as Error).message}`);
    }
  }

  /** Delete one or many keys. Supports wildcard patterns like "todos:123:*" */
  async invalidate(pattern: string): Promise<void> {
    try {
      if (pattern.includes('*')) {
        const keys = await this.redis.keys(pattern);
        if (keys.length) await this.redis.del(keys);
      } else {
        await this.redis.del(pattern);
      }
    } catch (err) {
      this.logger.warn(
        `cache.invalidate failed [${pattern}]: ${(err as Error).message}`,
      );
    }
  }

  /**
   * THE MAIN HELPER — "cache-aside" pattern in one line.
   * If key exists in Redis, return it. Otherwise run the loader,
   * save the result to Redis, and return it.
   */
  async wrap<T>(
    key: string,
    loader: () => Promise<T>,
    ttl = this.DEFAULT_TTL,
  ): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;

    const fresh = await loader();
    if (fresh !== null && fresh !== undefined) {
      await this.set(key, fresh, ttl);
    }
    return fresh;
  }

  /** Delete multiple patterns at once — useful after mutations. */
  async invalidateMany(patterns: string[]): Promise<void> {
    await Promise.all(patterns.map((p) => this.invalidate(p)));
  }
}
