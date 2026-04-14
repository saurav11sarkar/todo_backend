import { Module, Global } from '@nestjs/common';
import { createClient } from 'redis';
import config from 'src/app/config';
import { CacheService } from './cache.service';
import { REDIS_CLIENT } from './redis.constants';

export { REDIS_CLIENT };

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: async () => {
        const client = createClient({
          url: config.redis.redis_url,
        });
        client.on('error', (err) => console.error('Redis Error:', err));
        await client.connect();
        return client;
      },
    },
    CacheService,
  ],
  exports: [REDIS_CLIENT, CacheService],
})
export class RedisModule {}
