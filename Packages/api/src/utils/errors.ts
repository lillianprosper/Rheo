import { Request, Response, NextFunction } from 'express'
import { ZodError } from 'zod'
import { logger } from './logger'

// ─── Base application error ───────────────────────────────────────────────────
// All intentional errors thrown in route handlers extend this class.
// The global error handler checks instanceof AppError to decide status code.

export class AppError extends Error {
  public readonly statusCode: number
  public readonly code: string
  public readonly isOperational: boolean

  constructor(message: string, statusCode = 500, code = 'INTERNAL_ERROR') {
    super(message)
    this.name = 'AppError'
    this.statusCode = statusCode
    this.code = code
    this.isOperational = true
    Error.captureStackTrace(this, this.constructor)
  }
}

// ─── Named error subclasses ───────────────────────────────────────────────────

export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(`${resource} not found`, 404, 'NOT_FOUND')
    this.name = 'NotFoundError'
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409, 'CONFLICT')
    this.name = 'ConflictError'
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 422, 'VALIDATION_ERROR')
    this.name = 'ValidationError'
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, 401, 'UNAUTHORIZED')
    this.name = 'UnauthorizedError'
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(message, 403, 'FORBIDDEN')
    this.name = 'ForbiddenError'
  }
}

export class RateLimitError extends AppError {
  constructor(message = 'Too many requests') {
    super(message, 429, 'RATE_LIMITED')
    this.name = 'RateLimitError'
  }
}

// ─── Success response helpers ─────────────────────────────────────────────────

export function success<T>(res: Response, data: T, statusCode = 200): Response {
  return res.status(statusCode).json({ success: true, data })
}

export function paginated<T>(
  res: Response,
  data: T[],
  total: number,
  page: number,
  limit: number,
  statusCode = 200
): Response {
  return res.status(statusCode).json({
    success: true,
    data,
    meta: {
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
      hasNext: page * limit < total,
      hasPrev: page > 1,
    },
  })
}

// ─── Global error handler middleware ─────────────────────────────────────────

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (err instanceof ZodError) {
    const fields = err.errors.map((e) => ({
      field: e.path.join('.'),
      message: e.message,
    }))
    res.status(422).json({
      success: false,
      error: { message: 'Validation failed', code: 'VALIDATION_ERROR', fields },
    })
    return
  }

  if (err instanceof AppError && err.isOperational) {
    res.status(err.statusCode).json({
      success: false,
      error: { message: err.message, code: err.code },
    })
    return
  }

  logger.error('Unhandled error', {
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    requestId: req.headers['x-request-id'],
  })

  res.status(500).json({
    success: false,
    error: { message: 'An unexpected error occurred', code: 'INTERNAL_ERROR' },
  })
}
