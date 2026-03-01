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

  constructor() {
    if (isRedisConfigured()) {
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
