import Redis from 'ioredis';
import { config } from '../config/env';

let client: Redis | MemoryRedis | null = null;

/**
 * Redis is an accelerator, never a hard dependency: it backs the inventory hot
 * path, rate limiting and short-lived idempotency locks. When it is not
 * configured or unreachable we fall back to an in-process stub so local
 * development and CI keep working.
 */
class MemoryRedis {
  private store = new Map<string, { value: string; expiresAt: number | null }>();

  private sweep() {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.expiresAt !== null && entry.expiresAt <= now) this.store.delete(key);
    }
  }

  async get(key: string): Promise<string | null> {
    this.sweep();
    return this.store.get(key)?.value ?? null;
  }

  async set(key: string, value: string, mode?: string, ttlSeconds?: number): Promise<'OK'> {
    const expiresAt = mode?.toUpperCase() === 'EX' && ttlSeconds ? Date.now() + ttlSeconds * 1000 : null;
    this.store.set(key, { value, expiresAt });
    return 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      if (this.store.delete(key)) removed += 1;
    }
    return removed;
  }

  async incr(key: string): Promise<number> {
    const current = Number((await this.get(key)) ?? '0');
    const next = current + 1;
    await this.set(key, String(next));
    return next;
  }

  async expire(key: string, ttlSeconds: number): Promise<number> {
    const entry = this.store.get(key);
    if (!entry) return 0;
    entry.expiresAt = Date.now() + ttlSeconds * 1000;
    return 1;
  }

  async ttl(key: string): Promise<number> {
    const entry = this.store.get(key);
    if (!entry) return -2;
    if (entry.expiresAt === null) return -1;
    return Math.ceil((entry.expiresAt - Date.now()) / 1000);
  }

  async ping(): Promise<string> {
    return 'PONG';
  }

  async quit(): Promise<'OK'> {
    this.store.clear();
    return 'OK';
  }

  disconnect(): void {
    /* nothing to release */
  }
}

function createClient(): Redis | MemoryRedis {
  if (!config.redisUrl) return new MemoryRedis();

  const redis = new Redis(config.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 2,
    // Commands issued before the socket is up must wait rather than fail. With
    // this off, `redis.connect()` is still in flight when the first `cacheSet`
    // runs and the write is rejected with "Stream isn't writeable" — silently,
    // because `cacheSet` is best-effort. That is how a warmer can report every
    // route warmed while nothing is actually stored.
    //
    // The queue is bounded by `maxRetriesPerRequest`, so a genuinely dead Redis
    // still fails fast rather than hanging a request handler forever.
    enableOfflineQueue: true,
    retryStrategy: (times) => (times > 3 ? null : Math.min(times * 200, 2000)),
  });

  // Never let a Redis outage take the process down; callers already handle
  // cache misses, and Postgres remains the source of truth.
  redis.on('error', (error) => {
    if (process.env.NODE_ENV !== 'test') {
      console.warn('[redis] connection error:', error.message);
    }
  });
  redis.connect().catch(() => undefined);

  return redis;
}

export function getRedis(): Redis | MemoryRedis {
  if (!client) client = createClient();
  return client;
}

/**
 * True when a real Redis server backs the client.
 *
 * The in-memory fallback is a single-process stub: it cannot do Pub/Sub, so the
 * realtime bus uses this to decide whether it can fan events out across API
 * instances or has to stay process-local.
 */
export function hasRealRedis(): boolean {
  return getRedis() instanceof Redis;
}

/**
 * Opens a dedicated Pub/Sub connection.
 *
 * ioredis cannot run `subscribe()` and normal commands on the same connection,
 * so this duplicates the primary client. Returns `null` on the in-memory
 * fallback, and callers are expected to degrade gracefully.
 *
 * Errors are swallowed: a broken subscriber must never take down the API, it
 * only degrades realtime delivery to the local process.
 */
export function createSubscriberClient(): Redis | null {
  if (!hasRealRedis()) return null;

  try {
    const subscriber = (getRedis() as Redis).duplicate({
      lazyConnect: false,
      maxRetriesPerRequest: null,
      enableOfflineQueue: true,
    });
    subscriber.on('error', (error: Error) => {
      if (process.env.NODE_ENV !== 'test') {
        console.warn('[redis] subscriber error:', error.message);
      }
    });
    return subscriber;
  } catch (error) {
    console.warn('[redis] subscriber unavailable:', (error as Error).message);
    return null;
  }
}

export async function closeRedis(): Promise<void> {
  if (!client) return;
  await client.quit().catch(() => undefined);
  client.disconnect?.();
  client = null;
}

/** Cache helper that swallows failures and returns `null` on any problem. */
export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const raw = await getRedis().get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export async function cacheSet(key: string, value: unknown, ttlSeconds = 300): Promise<void> {
  try {
    await getRedis().set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch {
    /* cache is best-effort */
  }
}

export async function cacheDelete(pattern: string): Promise<void> {
  try {
    await getRedis().del(pattern);
  } catch {
    /* cache is best-effort */
  }
}