import { Module, Global } from '@nestjs/common';
import { createClient } from 'redis';
import config from 'src/app/config';

export const REDIS_CLIENT = 'REDIS_CLIENT';

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
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}
