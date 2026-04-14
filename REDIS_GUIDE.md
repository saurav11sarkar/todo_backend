# Redis — Production-Grade Setup (NestJS + node-redis v5)

A complete, reusable Redis layer for any NestJS backend.
This guide explains **what changed**, **why it changed**, and **how to use it** — in Bangla and English side-by-side, so তুমি pore আবার এই project copy করে নতুন project-এও use করতে পারো।

---

## 0. Files in this layer

```
src/redis/
├── redis.constants.ts   ← injection tokens (REDIS_CLIENT, REDIS_SUB_CLIENT)
├── redis.module.ts      ← @Global() module, 2 connections, graceful shutdown
└── cache.service.ts     ← the single API every service should use
```

Plus changes in:
- `src/app/config/index.ts` — added `redis.password`, `redis.prefix`
- `src/app/module/auth/auth.service.ts` — uses CacheService + JWT blacklist + OTP in Redis + login rate-limit
- `src/app/module/user/user.service.ts` — caches profile + paginated list with tags
- `src/app/module/todo/todo.service.ts` — switched to tag-based invalidation
- `docker-compose.yml` — Redis healthcheck + persistence + memory cap + LRU eviction
- `.env.example` — `REDIS_URL`, `REDIS_PASSWORD`, `REDIS_PREFIX`

---

## 1. কী কী change হয়েছে (TL;DR)

| # | আগে কী ছিল                                  | এখন কী হয়েছে                                                    | কেন                                                              |
|---|----------------------------------------------|------------------------------------------------------------------|-------------------------------------------------------------------|
| 1 | `redis.keys('todos:*')` দিয়ে invalidate     | `SCAN` cursor-based delete + tag-based invalidation              | `KEYS` Redis-কে block করে দেয় production-এ, app freeze হয়ে যায়    |
| 2 | কোনো reconnect strategy ছিল না             | Exponential backoff (50ms → 5s, 20 retries) + `keepAlive`        | network blip-এ app crash না করে নিজে নিজে heal করে                |
| 3 | কোনো graceful shutdown ছিল না              | `OnApplicationShutdown` → `client.quit()`                         | Docker SIGTERM-এ in-flight commands clean drain হয়, dangling connection থাকে না |
| 4 | AuthService **directly Redis client use করত** | শুধু CacheService inject করে                                    | Cache logic এক জায়গায় থাকে, test/মaintenance সহজ                  |
| 5 | OTP DB-তে save হত (`otp`, `otpExpires`)    | OTP সরাসরি Redis-এ `setEx(otp:email, code, 600)`                | Auto-expire, কোনো cron-cleanup লাগে না, DB write 2 কম             |
| 6 | JWT logout-এ token কিছু হতো না             | JWT blacklist Redis-এ token-এর natural expiry পর্যন্ত            | Logout secure হলো, leaked token revoke করা যায়                    |
| 7 | Login brute-force protection ছিল না        | `incr ratelimit:login:<ip>` 60 sec TTL, max 10                  | Password-spray attack বন্ধ                                         |
| 8 | Cache stampede protection ছিল না           | Single-flight lock (`SET NX PX`)                                 | 1000 request একসাথে miss হলে, 1টা DB query চলে — 999 wait করে    |
| 9 | Date object cache-এ string হয়ে যেত         | Custom JSON revival → `Date`/`BigInt` round-trip safe           | `created_at` cache থেকে আসলে আবার `new Date()` করতে হয় না        |
| 10 | dev/staging/prod একই Redis = key collision | Auto-prefix: `<app>:<env>:<key>` (config-driven)                 | একই Upstash instance share করে dev/prod চালানো safe              |
| 11 | Dev pub/sub করতে গেলে main connection break হত | আলাদা `REDIS_SUB_CLIENT` connection                          | node-redis-এ subscribe করা connection-এ অন্য command চলে না       |
| 12 | docker-compose Redis-এ persistence ছিল না  | AOF on + 256MB cap + `allkeys-lru` eviction + healthcheck        | Container restart-এ data থাকে; OOM-এ oldest key গুলো নিজে drop হয়|

---

## 2. The Cache API — তুমি শুধু এই 7টা method use করবে

```ts
constructor(private readonly cache: CacheService) {}

// READ
const user = await this.cache.get<User>('user:123');
const users = await this.cache.mget<User>(['user:1', 'user:2']);  // batch
const exists = await this.cache.exists('otp:foo@bar.com');

// WRITE
await this.cache.set('user:123', user, 600);                       // TTL = 600s
await this.cache.setEx('otp:email', '123456', 300);                // for raw strings
await this.cache.incr('ratelimit:login:1.2.3.4', 60);              // atomic counter

// DELETE
await this.cache.del('user:123');
await this.cache.invalidate('todos:user_123:*');                   // SCAN-safe wildcard
await this.cache.invalidateTags(['user:123', 'todos:all']);        // tag-based

// THE BIG ONE — cache-aside in 1 call
return this.cache.wrap(
  `user:${id}`,
  () => this.prisma.user.findUnique({ where: { id } }),
  { ttl: 600, tags: [`user:${id}`, 'users:all'] }
);
```

That's it. সব service-এ এই API use করো — আর কোনো `@Inject(REDIS_CLIENT)` দরকার নেই।

---

## 3. Tag-based invalidation কেন এত important

আগে তুমি এভাবে invalidate করতে:
```ts
await cache.invalidate(`todos:${userId}:*`);   // SCAN pattern
```
**Problem:** প্রতি update-এ পুরো keyspace SCAN করতে হয়। 10 lakh key থাকলে slow।

এখন:
```ts
// READ-এর সময় tag attach করো
await cache.wrap(`todos:${u}:p1:l10`, fn, { ttl: 300, tags: [`todos:${u}`] });
await cache.wrap(`todos:${u}:p2:l10`, fn, { ttl: 300, tags: [`todos:${u}`] });

// WRITE-এ পুরো tag মুছে দাও — O(1) lookup, O(N) delete
await cache.invalidateTags([`todos:${u}`]);
```

ভেতরে কী হয়: প্রতিটা tag একটা Redis SET। `wrap()` cache key-টা ওই SET-এ add করে। `invalidateTags()` SET থেকে সব member পড়ে এক pipeline-এ সব delete করে। কোনো SCAN লাগে না।

---

## 4. Single-flight lock — cache stampede কী এবং solve কীভাবে

**Scenario:**
`/todos` endpoint hot — সেকেন্ডে 5000 request। Cache TTL শেষ হল ঠিক 12:00:00.000-এ। পরবর্তী সেকেন্ডে 5000 request একসাথে miss করল → 5000 DB query → DB crash।

**Solve:**
`wrap()` ভেতরে `SET lock:<key> NX PX 5000` করে। যে first lock পাবে শুধু সে DB query চালাবে, বাকি সবাই 50ms wait করে cache re-check করবে।

```ts
// internally
const gotLock = await acquireLock(key);
if (!gotLock) {
  await sleep(50);
  const second = await get(key);   // 99% time এখানে hit হয়ে যাবে
  if (second !== null) return second;
}
const fresh = await loader();
await set(key, fresh, ttl);
```

DB load 5000× → 1× কমে যায়। এটা production-grade caching-এর গোপন সস।

---

## 5. কোথায় কোন pattern use করবে — quick reference

| Module / Use case        | Method          | Key                              | TTL      | Tag                         |
|--------------------------|-----------------|----------------------------------|----------|------------------------------|
| User profile             | `wrap`          | `user:<id>`                      | 10 min   | `user:<id>`                  |
| Paginated user list      | `wrap`          | `users:list:p1:l10:<fp>`         | 3 min    | `users:all`                  |
| Single todo              | `wrap`          | `todo:<userId>:<id>`             | 5 min    | `todo:<id>`, `todos:<userId>`|
| User's todo list         | `wrap`          | `todos:<userId>:p1:l10:<fp>`     | 5 min    | `todos:<userId>`             |
| OTP                      | `setEx`         | `otp:<email>`                    | 10 min   | —                            |
| OTP-verified window      | `setEx`         | `forgot:verified:<email>`        | 10 min   | —                            |
| JWT blacklist            | `setEx`         | `jwt:bl:<jti>`                   | = JWT exp| —                            |
| Login rate-limit         | `incr` + ttl    | `ratelimit:login:<ip>`           | 60 sec   | —                            |
| Distributed lock         | `set NX PX`     | `lock:<key>`                     | 5 sec    | —                            |

`fp` = filter fingerprint (params + sort) base64 — unique cache key per filter combo।

---

## 6. কেন `KEYS` use করা যাবে না — proof

Redis single-threaded। `KEYS *` 1 lakh key-এর উপর চালালে ~50ms+ পুরো server block করে। মানে ওই 50ms-এ আর কোনো command চলবে না — সব app freeze। `SCAN` সেটাই করে কিন্তু chunked (default 10 keys at a time), so কখনো block করে না। আমাদের `invalidate()` সবসময় SCAN use করে।

```bash
# Test it yourself
redis-cli DEBUG SLEEP 0  # baseline
redis-cli --latency-history -i 1 &
redis-cli KEYS '*'       # latency spike 50ms+ দেখবে
```

---

## 7. Setup checklist for new project

Copy this Redis layer to any NestJS project:

```bash
# 1. Copy files
cp src/redis/*.ts <new-project>/src/redis/

# 2. Install deps (already in this project)
npm install redis

# 3. Add env vars
echo "REDIS_URL=redis://localhost:6379" >> .env
echo "REDIS_PASSWORD=" >> .env
echo "REDIS_PREFIX=myapp" >> .env

# 4. config/index.ts-এ যোগ করো:
#    redis: { url: process.env.REDIS_URL, password: ..., prefix: ... }

# 5. AppModule-এ একবার import করো
#    imports: [RedisModule]   // Global, সব service auto-access পাবে

# 6. যেকোনো service-এ inject করো
#    constructor(private cache: CacheService) {}
```

Done। এখন wrap/get/set/invalidateTags use করতে পারবে।

---

## 8. Common mistakes to avoid

1. **Cache invalidate করতে ভুলে যাওয়া** — create/update/delete-এর শেষে সবসময় `invalidateTags(...)` কল করো।
2. **Transaction-এর ভেতরে cache-এ লেখা** — DB commit-এর পরে cache update করো, আগে না।
3. **Sensitive data cache করা** — raw password, full card number cache-এ রাখবে না।
4. **TTL না দেওয়া** — TTL ছাড়া cache infinite grow করে এবং stale হয়ে যায়।
5. **পুরো `KEYS *` scan করা** — production-এ একদম না। `invalidate()` already SCAN use করে, কিন্তু custom কোডে নিজে `redis.keys(...)` কখনো call করো না।
6. **সবকিছু cache করা** — যেটা request-প্রতি পাল্টায় (current timestamp, user-specific tokens) সেটা cache করো না।

---

## 9. Monitoring (production)

App startup-এ এটা দেখবে log-এ:
```
[Redis[main]]   Socket connected
[Redis[main]]   Ready to accept commands
[Redis[sub]]    Ready to accept commands
[CacheService]  Cache layer ready (PING → PONG)
```

Redis CLI দিয়ে namespace check:
```bash
redis-cli --scan --pattern 'todo:production:*' | head
redis-cli --scan --pattern 'todo:production:tag:*' | head   # tag sets
redis-cli --scan --pattern 'todo:production:lock:*'         # active locks
redis-cli INFO stats | grep keyspace_hits                    # hit ratio
```

Hit-ratio target: **80%+** for read-heavy endpoints। কম হলে TTL বাড়াও বা key-design rethink করো।

---

## 10. Final TL;DR

```ts
// READ
return cache.wrap(key, () => db.find(...), { ttl: 300, tags: [...] });

// WRITE
await db.update(...);
await cache.invalidateTags([...]);
```

এই 2 line-ই 95% caching covered। বাকি 5% (rate-limit, OTP, JWT blacklist) `incr` / `setEx` / `exists` দিয়ে। সব production-grade — KEYS নাই, stampede নাই, leak নাই।
