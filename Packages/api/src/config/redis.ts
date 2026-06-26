import { createClient, RedisClientType } from 'redis'
import { logger } from '../utils/logger'

// ─── Redis client ─────────────────────────────────────────────────────────────
// Redis serves three distinct roles in Rheo:
//   1. Token blacklist — revoked JTIs stored until their natural expiry
//   2. OTP store — 6-digit codes with short TTL (15min reset, 60min verify)
//   3. Driver presence — online/offline status + last-seen heartbeat
//
// STRIDE: Denial of Service — Redis is in-memory. If it goes down,
// blacklisted tokens become temporarily valid. Mitigate with Redis Sentinel
// or ElastiCache Multi-AZ in production.

// ─── Key namespaces ───────────────────────────────────────────────────────────
const K = {
  blacklist:   (jti: string)                  => `bl:${jti}`,
  otp:         (userId: string, purpose: string) => `otp:${userId}:${purpose}`,
  driverOnline:(driverId: string)             => `driver:online:${driverId}`,
  rateLimitIp: (ip: string)                   => `rl:ip:${ip}`,
}

// ─── Client setup ─────────────────────────────────────────────────────────────

let client: RedisClientType

export async function connectRedis(): Promise<void> {
  client = createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    password: process.env.REDIS_PASSWORD || undefined,
    socket: {
      reconnectStrategy: (retries) => {
        if (retries > 10) {
          logger.error('Redis: max reconnect attempts reached')
          return new Error('Redis reconnect failed')
        }
        return Math.min(retries * 100, 3000) // exponential backoff, max 3s
      },
    },
  }) as RedisClientType

  client.on('error', (err) => logger.error('Redis client error', { error: err.message }))
  client.on('reconnecting', () => logger.warn('Redis: reconnecting...'))
  client.on('ready', () => logger.info('Redis: connection ready'))

  await client.connect()
}

// ─── Redis interface ──────────────────────────────────────────────────────────

export const redis = {
  // ── Token blacklist ─────────────────────────────────────────────────────────

  /**
   * Blacklist a JWT by its jti claim until it would have naturally expired.
   * TTL = remaining seconds on the token so Redis auto-purges it.
   */
  async blacklistToken(jti: string, ttlSeconds: number): Promise<void> {
    await client.set(K.blacklist(jti), '1', { EX: ttlSeconds })
  },

  /**
   * Returns true if the jti is on the blacklist (token was revoked).
   */
  async isBlacklisted(jti: string): Promise<boolean> {
    return (await client.exists(K.blacklist(jti))) === 1
  },

  // ── OTP store ───────────────────────────────────────────────────────────────

  /**
   * Store a one-time passcode for a user + purpose.
   * Overwrites any existing OTP for the same key (rate-limiting handled at route level).
   */
  async setOtp(userId: string, purpose: string, otp: string, ttlSeconds: number): Promise<void> {
    await client.set(K.otp(userId, purpose), otp, { EX: ttlSeconds })
  },

  /**
   * Retrieve the stored OTP for comparison. Returns null if expired or not set.
   */
  async getOtp(userId: string, purpose: string): Promise<string | null> {
    return client.get(K.otp(userId, purpose))
  },

  /**
   * Delete an OTP after it has been used successfully.
   * Prevents replay attacks.
   */
  async deleteOtp(userId: string, purpose: string): Promise<void> {
    await client.del(K.otp(userId, purpose))
  },

  // ── Driver presence ─────────────────────────────────────────────────────────

  /**
   * Mark a driver as online with a TTL.
   * The cron job clears stale entries every 2 minutes.
   * Drivers must heartbeat to stay online.
   */
  async setDriverOnline(driverId: string, ttlSeconds = 180): Promise<void> {
    await client.set(K.driverOnline(driverId), Date.now().toString(), { EX: ttlSeconds })
  },

  async setDriverOffline(driverId: string): Promise<void> {
    await client.del(K.driverOnline(driverId))
  },

  async isDriverOnline(driverId: string): Promise<boolean> {
    return (await client.exists(K.driverOnline(driverId))) === 1
  },

  // ── Generic ─────────────────────────────────────────────────────────────────

  /** Raw client access for cases not covered by the interface above. */
  raw(): RedisClientType {
    return client
  },
}
