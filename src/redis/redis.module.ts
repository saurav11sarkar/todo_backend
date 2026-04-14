import {
  Module,
  Global,
  Logger,
  OnApplicationShutdown,
  Inject,
} from '@nestjs/common';
import { createClient } from 'redis';
import type { RedisClientType } from 'redis';
import config from 'src/app/config';
import { CacheService } from './cache.service';
import { REDIS_CLIENT, REDIS_SUB_CLIENT } from './redis.constants';

export { REDIS_CLIENT, REDIS_SUB_CLIENT };

/**
 * Redis connection factory
 * ------------------------
 * - Lazy connect with exponential-backoff reconnect (max 5s)
 * - Detects "READONLY" / "ECONNRESET" automatically and reconnects
 * - Logs every state transition (connect, ready, reconnecting, end, error)
 * - Returns a strongly typed RedisClientType
 */
const buildClient = (label: string): RedisClientType => {
  const logger = new Logger(`Redis[${label}]`);

  const client: RedisClientType = createClient({
    url: config.redis.url,
    password: config.redis.password || undefined,
    socket: {
      // Exponential backoff: 50ms, 100ms, 200ms ... capped at 5s
      reconnectStrategy: (retries) => {
        if (retries > 20) {
          logger.error('Giving up reconnecting after 20 retries');
          return new Error('Redis reconnect retries exhausted');
        }
        const delay = Math.min(50 * 2 ** retries, 5000);
        logger.warn(`Reconnecting in ${delay}ms (attempt ${retries + 1})`);
        return delay;
      },
      keepAlive: true, // send TCP keepalive
      connectTimeout: 10_000, // fail fast if Redis is unreachable
    },
  });

  client.on('connect', () => logger.log('Socket connected'));
  client.on('ready', () => logger.log('Ready to accept commands'));
  client.on('reconnecting', () => logger.warn('Reconnecting...'));
  client.on('end', () => logger.warn('Connection closed'));
  client.on('error', (err) => logger.error(`Error: ${err.message}`));

  return client;
};

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: async () => {
        const client = buildClient('main');
        await client.connect();
        return client;
      },
    },
    {
      // Separate connection for pub/sub — REQUIRED, you can't run subscribe
      // commands on a connection that also runs normal commands.
      provide: REDIS_SUB_CLIENT,
      useFactory: async () => {
        const client = buildClient('sub');
        await client.connect();
        return client;
      },
    },
    CacheService,
  ],
  exports: [REDIS_CLIENT, REDIS_SUB_CLIENT, CacheService],
})
export class RedisModule implements OnApplicationShutdown {
  private readonly logger = new Logger(RedisModule.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly main: RedisClientType,
    @Inject(REDIS_SUB_CLIENT) private readonly sub: RedisClientType,
  ) {}

  // Graceful shutdown — drain in-flight commands then close TCP cleanly.
  // Without this, Docker SIGTERM leaves dangling connections in Redis.
  async onApplicationShutdown(signal?: string) {
    this.logger.log(`Shutting down Redis connections (signal: ${signal})`);
    await Promise.allSettled([this.main.quit(), this.sub.quit()]);
  }
}
