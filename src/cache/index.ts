import { Redis } from '@upstash/redis';
import { CONFIG } from '../config';

const KEY_PREFIX = 'solenrich:';

interface MemoryEntry {
  value: string;
  expiry: number;
}

function isRedisConfigured(): boolean {
  return (
    CONFIG.cache.url !== '' &&
    !CONFIG.cache.url.startsWith('your_') &&
    CONFIG.cache.token !== '' &&
    !CONFIG.cache.token.startsWith('your_')
  );
}

export class Cache {
  private redis: Redis | null = null;
  private memory = new Map<string, MemoryEntry>();

  constructor(opts: { memoryOnly?: boolean } = {}) {
    // Unit tests must never write to the production Redis (a fixture ingest
    // once overwrote today's stonk snapshot chunk). Bun sets NODE_ENV=test.
    const memoryOnly = opts.memoryOnly === true || process.env.NODE_ENV === 'test';
    if (memoryOnly) {
      console.log('[cache] Using in-memory cache (test mode)');
    } else if (isRedisConfigured()) {
      try {
        this.redis = new Redis({ url: CONFIG.cache.url, token: CONFIG.cache.token });
        console.log('[cache] Using Upstash Redis');
      } catch (err) {
        console.warn('[cache] Failed to init Redis, falling back to in-memory:', err);
      }
    } else {
      console.log('[cache] Using in-memory cache (no Redis configured)');
    }
  }

  async get<T>(key: string): Promise<T | null> {
    const prefixed = KEY_PREFIX + key;
    try {
      if (this.redis) {
        const raw = await this.redis.get<string>(prefixed);
        if (raw === null || raw === undefined) return null;
        return typeof raw === 'string' ? JSON.parse(raw) : (raw as T);
      }
      // In-memory path
      const entry = this.memory.get(prefixed);
      if (!entry) return null;
      if (Date.now() > entry.expiry) {
        this.memory.delete(prefixed);
        return null;
      }
      return JSON.parse(entry.value);
    } catch (err) {
      console.warn(`[cache] get(${key}) failed:`, err);
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    const prefixed = KEY_PREFIX + key;
    try {
      const serialized = JSON.stringify(value);
      if (this.redis) {
        await this.redis.set(prefixed, serialized, { ex: ttlSeconds });
        return;
      }
      // In-memory path
      this.memory.set(prefixed, {
        value: serialized,
        expiry: Date.now() + ttlSeconds * 1000,
      });
    } catch (err) {
      console.warn(`[cache] set(${key}) failed:`, err);
    }
  }

  /** Batch get multiple keys in one round-trip */
  async mget<T>(keys: string[]): Promise<(T | null)[]> {
    if (keys.length === 0) return [];
    const prefixed = keys.map(k => KEY_PREFIX + k);
    try {
      if (this.redis) {
        const results = await this.redis.mget<string[]>(...prefixed);
        return results.map(raw => {
          if (raw === null || raw === undefined) return null;
          try { return typeof raw === 'string' ? JSON.parse(raw) : (raw as T); }
          catch { return null; }
        });
      }
      // In-memory path
      const now = Date.now();
      return prefixed.map(pk => {
        const entry = this.memory.get(pk);
        if (!entry || now > entry.expiry) return null;
        try { return JSON.parse(entry.value); }
        catch { return null; }
      });
    } catch (err) {
      console.warn(`[cache] mget failed:`, err);
      return keys.map(() => null);
    }
  }

  /** Set key only if it doesn't exist (NX). Returns true if set, false if already existed */
  async setIfAbsent<T>(key: string, value: T, ttlSeconds: number): Promise<boolean> {
    const prefixed = KEY_PREFIX + key;
    try {
      const serialized = JSON.stringify(value);
      if (this.redis) {
        const result = await this.redis.set(prefixed, serialized, { ex: ttlSeconds, nx: true });
        return result === 'OK';
      }
      // In-memory path
      const existing = this.memory.get(prefixed);
      if (existing && Date.now() < existing.expiry) return false;
      this.memory.set(prefixed, { value: serialized, expiry: Date.now() + ttlSeconds * 1000 });
      return true;
    } catch (err) {
      console.warn(`[cache] setIfAbsent(${key}) failed:`, err);
      return false;
    }
  }

  /** Increment a counter key by 1. Creates key with value 1 if it doesn't exist. */
  async incr(key: string, ttlSeconds?: number): Promise<number> {
    const prefixed = KEY_PREFIX + key;
    try {
      if (this.redis) {
        const val = await this.redis.incr(prefixed);
        if (ttlSeconds && val === 1) {
          await this.redis.expire(prefixed, ttlSeconds);
        }
        return val;
      }
      // In-memory path
      const entry = this.memory.get(prefixed);
      const current = entry && Date.now() < entry.expiry ? parseInt(entry.value, 10) || 0 : 0;
      const next = current + 1;
      const expiry = ttlSeconds ? Date.now() + ttlSeconds * 1000 : Date.now() + 86400 * 1000;
      this.memory.set(prefixed, { value: String(next), expiry });
      return next;
    } catch (err) {
      console.warn(`[cache] incr(${key}) failed:`, err);
      return 0;
    }
  }

  /** Add a member to a set, refreshing the TTL. Used for distinct-caller tracking. */
  async sadd(key: string, member: string, ttlSeconds?: number): Promise<void> {
    const prefixed = KEY_PREFIX + key;
    try {
      if (this.redis) {
        await this.redis.sadd(prefixed, member);
        if (ttlSeconds) await this.redis.expire(prefixed, ttlSeconds);
        return;
      }
      // In-memory path
      const entry = this.memory.get(prefixed);
      const members = new Set<string>(
        entry && Date.now() < entry.expiry ? JSON.parse(entry.value) : [],
      );
      members.add(member);
      this.memory.set(prefixed, {
        value: JSON.stringify([...members]),
        expiry: Date.now() + (ttlSeconds ?? 86400) * 1000,
      });
    } catch (err) {
      console.warn(`[cache] sadd(${key}) failed:`, err);
    }
  }

  /** Count members of a set. Returns 0 for missing keys. */
  async scard(key: string): Promise<number> {
    const prefixed = KEY_PREFIX + key;
    try {
      if (this.redis) {
        return await this.redis.scard(prefixed);
      }
      // In-memory path
      const entry = this.memory.get(prefixed);
      if (!entry || Date.now() > entry.expiry) return 0;
      return (JSON.parse(entry.value) as string[]).length;
    } catch (err) {
      console.warn(`[cache] scard(${key}) failed:`, err);
      return 0;
    }
  }

  /** List members of a set. Returns [] for missing keys. */
  async smembers(key: string): Promise<string[]> {
    const prefixed = KEY_PREFIX + key;
    try {
      if (this.redis) {
        return await this.redis.smembers(prefixed);
      }
      // In-memory path
      const entry = this.memory.get(prefixed);
      if (!entry || Date.now() > entry.expiry) return [];
      return JSON.parse(entry.value) as string[];
    } catch (err) {
      console.warn(`[cache] smembers(${key}) failed:`, err);
      return [];
    }
  }

  /** Scan keys matching a pattern (Redis SCAN, in-memory filter) */
  async keys(pattern: string): Promise<string[]> {
    const prefixed = KEY_PREFIX + pattern;
    try {
      if (this.redis) {
        const results: string[] = [];
        let cursor = 0;
        do {
          const [nextCursor, keys] = await this.redis.scan(cursor, { match: prefixed, count: 100 });
          cursor = typeof nextCursor === 'string' ? parseInt(nextCursor, 10) : nextCursor;
          results.push(...keys);
        } while (cursor !== 0);
        return results.map(k => k.replace(KEY_PREFIX, ''));
      }
      // In-memory path
      const regex = new RegExp('^' + prefixed.replace(/\*/g, '.*') + '$');
      const now = Date.now();
      return [...this.memory.keys()]
        .filter(k => regex.test(k) && now < (this.memory.get(k)?.expiry ?? 0))
        .map(k => k.replace(KEY_PREFIX, ''));
    } catch (err) {
      console.warn(`[cache] keys(${pattern}) failed:`, err);
      return [];
    }
  }

  /** Get raw string/number value without JSON parsing */
  async getRaw(key: string): Promise<string | null> {
    const prefixed = KEY_PREFIX + key;
    try {
      if (this.redis) {
        const raw = await this.redis.get<string>(prefixed);
        if (raw === null || raw === undefined) return null;
        return String(raw);
      }
      const entry = this.memory.get(prefixed);
      if (!entry || Date.now() > entry.expiry) return null;
      return entry.value;
    } catch (err) {
      console.warn(`[cache] getRaw(${key}) failed:`, err);
      return null;
    }
  }

  async del(key: string): Promise<void> {
    const prefixed = KEY_PREFIX + key;
    try {
      if (this.redis) {
        await this.redis.del(prefixed);
        return;
      }
      this.memory.delete(prefixed);
    } catch (err) {
      console.warn(`[cache] del(${key}) failed:`, err);
    }
  }
}
