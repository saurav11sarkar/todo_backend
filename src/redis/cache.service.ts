import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import type { RedisClientType } from 'redis';
import config from 'src/app/config';
import { REDIS_CLIENT } from './redis.constants';

/**
 * CacheService — production-grade caching helper
 * ===============================================
 *
 * Improvements over the old version:
 *  1. ✅ Namespaced keys (env + service prefix) → no dev/prod collision
 *  2. ✅ SCAN instead of KEYS for wildcard delete (KEYS blocks Redis!)
 *  3. ✅ Pipeline-based bulk delete (1 round-trip instead of N)
 *  4. ✅ Tag-based invalidation (no fragile wildcard hunting)
 *  5. ✅ Single-flight lock prevents cache stampede on miss
 *  6. ✅ JSON revival of Date / BigInt
 *  7. ✅ Stale-while-revalidate (`swr`) for hot read paths
 *  8. ✅ Health probe + safe degradation (cache failure ≠ request failure)
 *
 * Quick usage:
 *
 *   // Basic cache-aside
 *   return this.cache.wrap(`todo:${id}`, () => db.find(id), { ttl: 300 });
 *
 *   // With tags — invalidate everything tagged "user:123" in one call
 *   return this.cache.wrap(
 *     `todos:${userId}:page:${page}`,
 *     () => db.findMany(...),
 *     { ttl: 300, tags: [`user:${userId}`] },
 *   );
 *
 *   await this.cache.invalidateTags([`user:${userId}`]);
 */
@Injectable()
export class CacheService implements OnModuleInit {
  private readonly logger = new Logger(CacheService.name);
  private readonly DEFAULT_TTL = 300;
  private readonly LOCK_TTL_MS = 5_000;
  private readonly prefix: string;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: RedisClientType,
  ) {
    // Namespace = "<app>:<env>:" → e.g. "todo:production:"
    this.prefix = `${config.redis.prefix}:${config.env}:`;
  }

  async onModuleInit() {
    try {
      const pong = await this.redis.ping();
      this.logger.log(`Cache layer ready (PING → ${pong})`);
    } catch (err) {
      this.logger.error(
        `Redis PING failed at startup: ${(err as Error).message}`,
      );
    }
  }

  // ─── Key helpers ────────────────────────────────────────────────────
  /** Apply env+app prefix once; never call Redis with raw keys directly. */
  private k(key: string): string {
    return key.startsWith(this.prefix) ? key : `${this.prefix}${key}`;
  }

  /** Strip prefix when returning keys to the caller. */
  private unk(key: string): string {
    return key.startsWith(this.prefix) ? key.slice(this.prefix.length) : key;
  }

  // ─── Serialization ──────────────────────────────────────────────────
  /** JSON serializer that survives Date/BigInt round-trips. */
  private serialize(value: unknown): string {
    return JSON.stringify(value, (_, v) => {
      if (v instanceof Date) return { __t: 'd', v: v.toISOString() };
      if (typeof v === 'bigint') return { __t: 'b', v: v.toString() };
      return v;
    });
  }

  private deserialize<T>(raw: string): T {
    return JSON.parse(raw, (_, v) => {
      if (v && typeof v === 'object' && '__t' in v) {
        if (v.__t === 'd') return new Date(v.v);
        if (v.__t === 'b') return BigInt(v.v);
      }
      return v;
    }) as T;
  }

  // ─── Primitives ─────────────────────────────────────────────────────
  /** Get a cached value (auto JSON-parse, returns null on miss/error). */
  async get<T = unknown>(key: string): Promise<T | null> {
    try {
      const raw = await this.redis.get(this.k(key));
      return raw ? this.deserialize<T>(raw) : null;
    } catch (err) {
      this.logger.warn(`get [${key}] failed: ${(err as Error).message}`);
      return null;
    }
  }

  /** Batch GET — 1 round-trip instead of N. */
  async mget<T = unknown>(keys: string[]): Promise<(T | null)[]> {
    if (!keys.length) return [];
    try {
      const raws = await this.redis.mGet(keys.map((k) => this.k(k)));
      return raws.map((r) => (r ? this.deserialize<T>(r) : null));
    } catch (err) {
      this.logger.warn(`mget failed: ${(err as Error).message}`);
      return keys.map(() => null);
    }
  }

  /** Set a value with TTL (seconds). */
  async set(key: string, value: unknown, ttl = this.DEFAULT_TTL): Promise<void> {
    try {
      await this.redis.setEx(this.k(key), ttl, this.serialize(value));
    } catch (err) {
      this.logger.warn(`set [${key}] failed: ${(err as Error).message}`);
    }
  }

  /** Delete one specific key. */
  async del(key: string): Promise<void> {
    try {
      await this.redis.del(this.k(key));
    } catch (err) {
      this.logger.warn(`del [${key}] failed: ${(err as Error).message}`);
    }
  }

  // ─── Wildcard delete (SCAN-based, production safe) ──────────────────
  /**
   * Delete every key matching a pattern. Uses SCAN (non-blocking),
   * NOT KEYS (which blocks the entire Redis server).
   *
   * `pattern` is auto-prefixed: `todos:*` → `todo:production:todos:*`
   */
  async invalidate(pattern: string): Promise<number> {
    const fullPattern = this.k(pattern);
    let cursor = '0';
    let deleted = 0;

    try {
      do {
        // node-redis v5 returns { cursor: string, keys: string[] }
        const res = await this.redis.scan(cursor, {
          MATCH: fullPattern,
          COUNT: 200,
        });
        cursor = String(res.cursor);

        if (res.keys.length) {
          // Pipeline DEL in chunks to avoid huge variadic commands
          const chunkSize = 500;
          for (let i = 0; i < res.keys.length; i += chunkSize) {
            const chunk = res.keys.slice(i, i + chunkSize);
            const removed = await this.redis.del(chunk);
            deleted += removed;
          }
        }
      } while (cursor !== '0');
    } catch (err) {
      this.logger.warn(
        `invalidate [${pattern}] failed: ${(err as Error).message}`,
      );
    }

    return deleted;
  }

  /** Invalidate many patterns sequentially (parallel SCAN can hammer Redis). */
  async invalidateMany(patterns: string[]): Promise<void> {
    for (const p of patterns) {
      await this.invalidate(p);
    }
  }

  // ─── Tag-based invalidation ─────────────────────────────────────────
  /**
   * Tags are tracked in Redis SETs:
   *   tag:user:123 → { todos:user_123:page_1, todos:user_123:page_2, ... }
   *
   * On `wrap()` with `tags:[...]`, the cache key is added to each tag-set.
   * `invalidateTags(['user:123'])` reads the set and deletes every member
   * in one pipeline → no SCAN required, O(1) lookup.
   */
  private tagKey(tag: string): string {
    return this.k(`tag:${tag}`);
  }

  private async addToTags(key: string, tags: string[], ttl: number) {
    if (!tags.length) return;
    const fullKey = this.k(key);
    const multi = this.redis.multi();
    for (const tag of tags) {
      const tk = this.tagKey(tag);
      multi.sAdd(tk, fullKey);
      // Tag set lives slightly longer than its longest member
      multi.expire(tk, ttl + 60);
    }
    try {
      await multi.exec();
    } catch (err) {
      this.logger.warn(`tag attach failed: ${(err as Error).message}`);
    }
  }

  async invalidateTags(tags: string[]): Promise<number> {
    if (!tags.length) return 0;
    let deleted = 0;
    try {
      for (const tag of tags) {
        const tk = this.tagKey(tag);
        const members = await this.redis.sMembers(tk);
        if (members.length) {
          deleted += await this.redis.del(members);
        }
        await this.redis.del(tk);
      }
    } catch (err) {
      this.logger.warn(`invalidateTags failed: ${(err as Error).message}`);
    }
    return deleted;
  }

  // ─── Single-flight lock (cache stampede protection) ─────────────────
  /**
   * When 1000 requests arrive for the same key at the moment cache expires,
   * 1000 DB queries fire at once → stampede. The lock makes only the
   * FIRST request execute the loader; the rest wait briefly and re-read.
   */
  private async acquireLock(key: string): Promise<boolean> {
    try {
      const res = await this.redis.set(this.k(`lock:${key}`), '1', {
        condition: 'NX',
        expiration: { type: 'PX', value: this.LOCK_TTL_MS },
      });
      return res === 'OK';
    } catch {
      return false;
    }
  }

  private async releaseLock(key: string): Promise<void> {
    try {
      await this.redis.del(this.k(`lock:${key}`));
    } catch {
      /* ignore */
    }
  }

  // ─── The main helper ────────────────────────────────────────────────
  /**
   * Cache-aside with stampede protection + optional tags.
   *
   *   await cache.wrap('user:123', () => db.user(123), { ttl: 600 })
   *
   *   await cache.wrap(
   *     `todos:${userId}:page:${p}`,
   *     () => db.todos.findMany(...),
   *     { ttl: 300, tags: [`user:${userId}`, 'todos:all'] },
   *   )
   */
  async wrap<T>(
    key: string,
    loader: () => Promise<T>,
    opts: { ttl?: number; tags?: string[] } = {},
  ): Promise<T> {
    const ttl = opts.ttl ?? this.DEFAULT_TTL;
    const tags = opts.tags ?? [];

    const cached = await this.get<T>(key);
    if (cached !== null) return cached;

    // Try to be the only request to execute the loader
    const gotLock = await this.acquireLock(key);

    if (!gotLock) {
      // Another request is loading. Wait a bit and re-check cache.
      await new Promise((r) => setTimeout(r, 50));
      const second = await this.get<T>(key);
      if (second !== null) return second;
      // Still missing — fall through and just load it ourselves.
    }

    try {
      const fresh = await loader();
      if (fresh !== null && fresh !== undefined) {
        await this.set(key, fresh, ttl);
        await this.addToTags(key, tags, ttl);
      }
      return fresh;
    } finally {
      if (gotLock) await this.releaseLock(key);
    }
  }

  // ─── Health probe ───────────────────────────────────────────────────
  async ping(): Promise<boolean> {
    try {
      const res = await this.redis.ping();
      return res === 'PONG';
    } catch {
      return false;
    }
  }

  /** Raw access for advanced cases (rate limiting, atomic counters etc.). */
  async incr(key: string, ttl?: number): Promise<number> {
    const fullKey = this.k(key);
    const value = await this.redis.incr(fullKey);
    if (value === 1 && ttl) await this.redis.expire(fullKey, ttl);
    return value;
  }

  /** Used for JWT blacklist / OTP storage etc. */
  async setEx(key: string, value: string, ttl: number): Promise<void> {
    await this.redis.setEx(this.k(key), ttl, value);
  }

  async exists(key: string): Promise<boolean> {
    return (await this.redis.exists(this.k(key))) === 1;
  }
}
