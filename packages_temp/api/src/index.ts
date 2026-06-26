import 'express-async-errors'
import dotenv from 'dotenv'
dotenv.config()

import http from 'http'
import express from 'express'
import helmet from 'helmet'
import cors from 'cors'
import compression from 'compression'
import morgan from 'morgan'

import { pool } from './config/database'
import { connectRedis } from './config/redis'
import { initSocket } from './config/socket'
import { logger } from './utils/logger'
import { errorHandler } from './utils/errors'
import { generalLimiter, authLimiter, otpLimiter, locationLimiter, webhookLimiter } from './middleware/rateLimiter'
import { sanitizeBody } from './middleware/validation'
import { startCronJobs } from './cron/jobs'

// Route modules
import { authRouter }      from './modules/auth/auth.routes'
import { driverRouter }    from './modules/drivers/driver.routes'
import { jobRouter }       from './modules/jobs/job.routes'
import { businessRouter }  from './modules/businesses/business.routes'
import { analyticsRouter } from './modules/analytics/analytics.routes'
import { supportRouter }   from './modules/support/support.routes'
import { paymentRouter }   from './modules/payments/payment.routes'
import { adminRouter }     from './modules/admin/admin.routes'

const app = express()
const server = http.createServer(app)
const PORT = process.env.PORT || 4000
const API = `/api/${process.env.API_VERSION || 'v1'}`

// ─── Security headers ────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'"],
      styleSrc:   ["'self'", "'unsafe-inline'"],
      imgSrc:     ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
    },
  },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  noSniff: true,
  xssFilter: true,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}))

// ─── CORS ────────────────────────────────────────────────────────────────────
const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:3000').split(',').map(o => o.trim())

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true)
    } else {
      logger.warn('CORS blocked request', { origin })
      callback(new Error('Not allowed by CORS'))
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Device-FP', 'X-Request-ID'],
  exposedHeaders: ['X-Total-Count', 'X-Rate-Limit-Remaining'],
}))

// ─── Webhook route FIRST (needs raw body before json parser) ─────────────────
app.use(`${API}/payments/webhook`, webhookLimiter, paymentRouter)

// ─── Body parsing ────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true, limit: '10mb' }))
app.use(compression())
app.use(sanitizeBody)

// ─── Request logging ─────────────────────────────────────────────────────────
app.use(morgan('combined', {
  stream: { write: (msg) => logger.http(msg.trim()) },
  skip: (req) => req.path === '/health',
}))

// ─── Request ID ──────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  req.headers['x-request-id'] = req.headers['x-request-id'] || `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  res.setHeader('X-Request-ID', req.headers['x-request-id'])
  next()
})

// ─── Global rate limit ───────────────────────────────────────────────────────
app.use(generalLimiter)

// ─── Health check ────────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1')
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: process.env.API_VERSION || 'v1',
      environment: process.env.NODE_ENV,
    })
  } catch {
    res.status(503).json({ status: 'unhealthy', timestamp: new Date().toISOString() })
  }
})

// ─── API Routes ──────────────────────────────────────────────────────────────

// Auth (all surfaces)
app.use(`${API}/auth`, authLimiter, authRouter)
app.use(`${API}/auth/forgot-password`, otpLimiter)
app.use(`${API}/auth/verify-email`, otpLimiter)

// Driver routes
app.use(`${API}/drivers`, driverRouter)

// Job routes
app.use(`${API}/jobs/tracking/location`, locationLimiter)  // Strict limit on location updates
app.use(`${API}/jobs`, jobRouter)

// Business routes
app.use(`${API}/businesses`, businessRouter)

// Analytics
app.use(`${API}/analytics`, analyticsRouter)

// Support
app.use(`${API}/support`, supportRouter)

// Payments (non-webhook)
app.use(`${API}/payments`, paymentRouter)

// Admin (Rheo staff only)
app.use(`${API}/admin`, adminRouter)

// ─── 404 handler ─────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: { message: `Route ${req.method} ${req.path} not found`, code: 'NOT_FOUND' },
  })
})

// ─── Global error handler ─────────────────────────────────────────────────────
app.use(errorHandler)

// ─── Bootstrap ───────────────────────────────────────────────────────────────
async function bootstrap() {
  try {
    // Test DB connection
    await pool.query('SELECT NOW()')
    logger.info('PostgreSQL connected')

    // Connect Redis
    await connectRedis()
    logger.info('Redis connected')

    // Init WebSocket server
    initSocket(server)
    logger.info('WebSocket server initialized')

    // Start cron jobs
    startCronJobs()

    // Start HTTP server
    server.listen(PORT, () => {
      logger.info(`🚀 Rheo API running`, {
        port: PORT,
        env: process.env.NODE_ENV,
        api: API,
      })
    })
  } catch (err: any) {
    logger.error('Failed to start server', { error: err.message })
    process.exit(1)
  }
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received — shutting down gracefully')
  server.close(async () => {
    await pool.end()
    logger.info('Server closed')
    process.exit(0)
  })
})

process.on('SIGINT', async () => {
  logger.info('SIGINT received — shutting down gracefully')
  server.close(async () => {
    await pool.end()
    process.exit(0)
  })
})

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { reason })
})

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack })
  process.exit(1)
})

bootstrap()

export { app, server }
