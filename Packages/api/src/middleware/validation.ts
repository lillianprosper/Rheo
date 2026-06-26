import { Request, Response, NextFunction } from 'express'

// ─── Input sanitization ───────────────────────────────────────────────────────
// STRIDE: Tampering — strip prototype pollution and null-byte injection
// from all incoming request bodies before they reach route handlers.
// Zod schemas in each route are the primary validation layer;
// this middleware is a secondary defense-in-depth measure.

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function sanitize(obj: unknown, depth = 0): unknown {
  if (depth > 10 || obj === null || typeof obj !== 'object') return obj
  if (Array.isArray(obj)) return obj.map((item) => sanitize(item, depth + 1))

  const clean: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    // Drop prototype pollution keys
    if (DANGEROUS_KEYS.has(key)) continue
    // Strip null bytes from string values
    const sanitizedValue = typeof value === 'string'
      ? value.replace(/\0/g, '').trim()
      : sanitize(value, depth + 1)
    clean[key] = sanitizedValue
  }
  return clean
}

export function sanitizeBody(req: Request, _res: Response, next: NextFunction): void {
  if (req.body && typeof req.body === 'object') {
    req.body = sanitize(req.body)
  }
  next()
}

// ─── Rate limiter middleware ──────────────────────────────────────────────────

import rateLimit from 'express-rate-limit'

const windowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000') // 15 min

// General API limit — 100 req per 15 min per IP
export const generalLimiter = rateLimit({
  windowMs,
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100'),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { message: 'Too many requests', code: 'RATE_LIMITED' } },
})

// Auth endpoints — 10 attempts per 15 min (login, register)
export const authLimiter = rateLimit({
  windowMs,
  max: parseInt(process.env.AUTH_RATE_LIMIT_MAX || '10'),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { message: 'Too many auth attempts. Try again later.', code: 'RATE_LIMITED' } },
})

// OTP endpoints — 5 attempts per 15 min (forgot password, verify email)
export const otpLimiter = rateLimit({
  windowMs,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { message: 'Too many OTP requests. Try again later.', code: 'RATE_LIMITED' } },
})

// GPS location updates — 30 per min per IP (drivers send every ~3s)
export const locationLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { message: 'Location update rate limit exceeded', code: 'RATE_LIMITED' } },
})

// Flutterwave webhook — 60 per min (payment events can burst)
export const webhookLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
})
