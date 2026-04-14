# Redis Caching — Simple & Reusable Guide

This guide shows **where** to use Redis in a typical backend project, and **how** to use it with the minimum code. The pattern here works in any Node.js / NestJS project.

---

## 1. The Golden Rule — When to Cache

Cache data that is **read often and changed rarely**.

| Use Redis for                  | Don't use Redis for                    |
| ------------------------------ | -------------------------------------- |
| Lists (pagination results)     | Data that changes every second         |
| Detail pages (`GET /todos/:id`)| Very small, one-off lookups            |
| User profile / settings        | Sensitive raw passwords                |
| Counters, leaderboards         | Transactional writes needing ACID      |
| Rate limiting counters         | Huge blobs (> 1 MB per key)            |
| JWT blacklist / session store  | Data that MUST always be latest-truth  |
| Search / filter results        |                                        |
| OTP codes, email verify tokens |                                        |

---

## 2. The Pattern — Cache-Aside (the only one you need)

```
    Request
       │
       ▼
  ┌────────────┐   hit    ┌─────────┐
  │  Redis     │─────────►│ Return  │
  │  cache?    │          └─────────┘
  └────┬───────┘
       │ miss
       ▼
  ┌────────────┐
  │ DB query   │
  └────┬───────┘
       │
       ▼
  ┌────────────┐
  │ Save to    │
  │ Redis (TTL)│
  └────┬───────┘
       │
       ▼
  Return to user
```

Our `CacheService.wrap()` does all of this in one line.

---

## 3. Setup (once per project)

### a. Install

```bash
npm install redis
```

### b. Drop in these 2 files

**`src/redis/redis.module.ts`** — creates the Redis connection.
**`src/redis/cache.service.ts`** — the reusable helper (`wrap`, `get`, `set`, `invalidate`).

Both already exist in this project — copy them to any new project and you're done.

### c. Register globally

`RedisModule` is already `@Global()` — import it once in `AppModule` and every service can inject `CacheService`.

---

## 4. How to Use — 3 Steps

### Step 1 — Inject the service

```ts
constructor(private readonly cache: CacheService) {}
```

### Step 2 — Wrap your READ queries

```ts
async findAll(userId: string) {
  return this.cache.wrap(
    `todos:${userId}`,           // cache key
    () => this.prisma.todo.findMany({ where: { userId } }),
    300,                         // TTL seconds (optional, default 5 min)
  );
}
```

That's it. First call hits the DB. Next calls for 5 minutes → served from Redis (millisecond response).

### Step 3 — Invalidate on WRITE operations

Whenever data changes, kill the stale cache:

```ts
async createTodo(userId: string, dto) {
  const created = await this.prisma.todo.create({ data: { ...dto, userId } });
  await this.cache.invalidate(`todos:${userId}:*`);   // wildcard supported
  return created;
}
```

---

## 5. Key Naming Convention (IMPORTANT)

Use **`resource:id:subresource`** style, always lowercase, colon-separated:

| Good                           | Bad                  |
| ------------------------------ | -------------------- |
| `user:123`                     | `User_123`           |
| `todos:user_123:page_1:lim_10` | `todoList_u123p1`    |
| `otp:+8801xxxx`                | `otpCode`            |
| `session:abc...`               | `sess abc`           |

Put a **key builder** at the top of each service:

```ts
private keys = {
  one:  (userId, id) => `todo:${userId}:${id}`,
  list: (userId, page, limit) => `todos:${userId}:${page}:${limit}`,
  allOfUser: (userId) => `todos:${userId}:*`,   // for invalidation
};
```

This single habit is what makes caching maintainable long-term.

---

## 6. Where to Use Redis in THIS Project

| Module            | Target                                | Key pattern                          | TTL   |
| ----------------- | ------------------------------------- | ------------------------------------ | ----- |
| **todo** ✅       | List + single todo (already done)     | `todos:{userId}:*`, `todo:{u}:{id}`  | 5 min |
| **user**          | Cache `getProfile(userId)`            | `user:{id}`                          | 10 min|
| **auth**          | OTP codes                             | `otp:{email_or_phone}`               | 5 min |
| **auth**          | JWT blacklist (on logout)             | `jwt:blacklist:{jti}`                | =JWT expiry |
| **auth**          | Login rate limit                      | `ratelimit:login:{ip}`               | 60 sec|
| **auth**          | Refresh tokens                        | `refresh:{userId}:{tokenId}`         | 7 days|

### Example: cache user profile

```ts
// user.service.ts
async getProfile(id: string) {
  return this.cache.wrap(
    `user:${id}`,
    () => this.prisma.user.findUnique({ where: { id } }),
    600,
  );
}

async updateProfile(id: string, dto) {
  const updated = await this.prisma.user.update({ where: { id }, data: dto });
  await this.cache.invalidate(`user:${id}`);
  return updated;
}
```

### Example: OTP storage (replaces DB table)

```ts
// auth.service.ts
async sendOtp(email: string) {
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  await this.cache.set(`otp:${email}`, code, 300); // expires in 5 min
  await this.mail.send(email, `Your OTP: ${code}`);
}

async verifyOtp(email: string, input: string) {
  const saved = await this.cache.get<string>(`otp:${email}`);
  if (saved !== input) throw new UnauthorizedException('Invalid OTP');
  await this.cache.invalidate(`otp:${email}`);
  return true;
}
```

---

## 7. TTL (Time-To-Live) — Quick Reference

| Data type                | TTL          |
| ------------------------ | ------------ |
| OTP / magic link         | 5 min        |
| Search results           | 1–5 min      |
| List / pagination        | 3–10 min     |
| User profile             | 10–30 min    |
| Static config / settings | 1–24 hours   |
| Session / JWT blacklist  | = token expiry |

Rule: shorter TTL = fresher data, less speedup. Longer TTL = faster, but risk showing old data if you forget to invalidate.

---

## 8. Common Mistakes to Avoid

1. **Forgetting to invalidate** on create/update/delete → users see old data.
2. **Using `KEYS *` in production** — it blocks Redis. Our `invalidate()` uses it only for wildcards; for huge keyspaces use `SCAN` instead.
3. **Caching inside a transaction** — cache only after DB commit succeeds.
4. **Storing sensitive raw data** (raw passwords, full card numbers).
5. **No TTL** — cache grows forever and goes stale.

---

## 9. Reusing in Another Project

To copy this pattern into a brand-new NestJS project:

```bash
# 1. Copy two files
cp src/redis/redis.module.ts <new-project>/src/redis/
cp src/redis/cache.service.ts <new-project>/src/redis/

# 2. Install deps
npm install redis

# 3. Add env var
REDIS_URL=redis://localhost:6379

# 4. Import RedisModule once in AppModule
```

Then in any service: inject `CacheService`, use `wrap()` on reads, `invalidate()` on writes. Done.

---

## TL;DR

```ts
// READ  → wrap
return this.cache.wrap(`key:${id}`, () => db.find(id), 300);

// WRITE → invalidate
await db.update(...);
await this.cache.invalidate(`key:${id}`);
```

That's 90% of Redis caching you'll ever need.
