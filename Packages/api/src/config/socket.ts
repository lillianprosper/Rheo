import { Server as HttpServer } from 'http'
import { Server as SocketServer, Socket } from 'socket.io'
import { logger } from '../utils/logger'
import { verifyAccessToken } from '../utils/jwt'
import { redis } from './redis'

// ─── WebSocket server ─────────────────────────────────────────────────────────
// STRIDE: Spoofing — every socket connection must present a valid JWT.
//   Tokens are verified on handshake. Invalid tokens are rejected immediately.
// STRIDE: Elevation of Privilege — drivers only join their own room.
//   Businesses join their own room. No cross-surface room access.
//
// Room naming:
//   driver:{driverId}     — receives job:new, job:cancelled, support:reply
//   business:{businessId} — receives job:assigned, job:status, driver:location
//   job:{jobId}           — used for real-time tracking subscription

let io: SocketServer

export function initSocket(server: HttpServer): SocketServer {
  io = new SocketServer(server, {
    cors: {
      origin: (process.env.CORS_ORIGINS || 'http://localhost:3000')
        .split(',')
        .map((o) => o.trim()),
      credentials: true,
    },
    // Ping every 25s, disconnect after 2 missed pings (50s timeout)
    pingTimeout: 50_000,
    pingInterval: 25_000,
    // Limit payload size — GPS updates are tiny, prevent abuse
    maxHttpBufferSize: 1e4, // 10KB
  })

  // ── Auth middleware ─────────────────────────────────────────────────────────
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token?.replace('Bearer ', '')
      if (!token) return next(new Error('Authentication required'))

      // Try each surface — driver app and business dashboard both connect here
      let payload: ReturnType<typeof verifyAccessToken> | null = null

      for (const surface of ['driver', 'business', 'staff'] as const) {
        try {
          payload = verifyAccessToken(token, surface)
          break
        } catch {
          // Try next surface
        }
      }

      if (!payload) return next(new Error('Invalid token'))

      // Check blacklist
      if (payload.jti && await redis.isBlacklisted(payload.jti)) {
        return next(new Error('Token has been revoked'))
      }

      // Attach auth context to socket
      socket.data.auth = payload
      next()
    } catch (err: any) {
      logger.warn('Socket auth failed', { error: err.message })
      next(new Error('Authentication failed'))
    }
  })

  // ── Connection handler ──────────────────────────────────────────────────────
  io.on('connection', (socket: Socket) => {
    const { auth } = socket.data

    // Join surface-specific room on connect
    if (auth.surface === 'driver' && auth.driverId) {
      socket.join(`driver:${auth.driverId}`)
      logger.debug('Driver connected to socket', { driverId: auth.driverId })
    }

    if (auth.surface === 'business' && auth.businessId) {
      socket.join(`business:${auth.businessId}`)
      logger.debug('Business connected to socket', { businessId: auth.businessId })
    }

    // ── Driver events ─────────────────────────────────────────────────────────

    // After accepting a job, driver subscribes to the job room
    socket.on('job:subscribe', (jobId: string) => {
      if (auth.surface !== 'driver') return
      if (typeof jobId !== 'string' || !jobId.match(/^[0-9a-f-]{36}$/)) return // UUID validation
      socket.join(`job:${jobId}`)
      logger.debug('Driver subscribed to job room', { driverId: auth.driverId, jobId })
    })

    // Keepalive heartbeat — update driver online status in Redis
    socket.on('ping', async () => {
      if (auth.surface === 'driver' && auth.driverId) {
        await redis.setDriverOnline(auth.driverId)
      }
    })

    // ── Business events ───────────────────────────────────────────────────────

    // Business subscribes to real-time GPS tracking for a job
    socket.on('track:job', (jobId: string) => {
      if (auth.surface !== 'business') return
      if (typeof jobId !== 'string' || !jobId.match(/^[0-9a-f-]{36}$/)) return
      socket.join(`job:${jobId}`)
      logger.debug('Business subscribed to job tracking', { businessId: auth.businessId, jobId })
    })

    socket.on('disconnect', (reason) => {
      logger.debug('Socket disconnected', {
        surface: auth.surface,
        reason,
        id: socket.id,
      })
    })
  })

  logger.info('WebSocket server initialized')
  return io
}

/**
 * Get the Socket.io instance for emitting events from route handlers.
 * Call after initSocket() — throws if socket server is not yet initialized.
 */
export function getIO(): SocketServer {
  if (!io) throw new Error('Socket.io not initialized — call initSocket() first')
  return io
}

// ─── Typed emit helpers ───────────────────────────────────────────────────────
// Use these instead of raw io.to().emit() to keep event names consistent.

export const emit = {
  // To a specific driver
  toDriver: (driverId: string, event: string, data: unknown) =>
    getIO().to(`driver:${driverId}`).emit(event, data),

  // To all members of a business
  toBusiness: (businessId: string, event: string, data: unknown) =>
    getIO().to(`business:${businessId}`).emit(event, data),

  // To all subscribers of a job (driver + tracking business)
  toJob: (jobId: string, event: string, data: unknown) =>
    getIO().to(`job:${jobId}`).emit(event, data),

  // Broadcast to all connected drivers (new job on board)
  toAllDrivers: (event: string, data: unknown) =>
    getIO().emit(event, data),
}
