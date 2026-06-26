import winston from 'winston'

const level = (): string =>
  process.env.NODE_ENV === 'production' ? 'info' : 'debug'

const REDACTED = '[REDACTED]'
const SENSITIVE_KEYS = new Set([
  'password', 'password_hash', 'passwordHash',
  'token', 'accessToken', 'refreshToken', 'access_token', 'refresh_token',
  'two_fa_secret', 'twoFaSecret', 'totp', 'otp', 'otp_hash',
  'authorization', 'Authorization',
  'nin', 'account_number', 'accountNumber',
  'encryption_key', 'jwt_secret', 'x-api-key', 'cookie',
])

function redact(obj: unknown, depth = 0): unknown {
  if (depth > 6 || obj === null || typeof obj !== 'object') return obj
  if (Array.isArray(obj)) return obj.map((item) => redact(item, depth + 1))
  const sanitized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    sanitized[key] = SENSITIVE_KEYS.has(key) ? REDACTED : redact(value, depth + 1)
  }
  return sanitized
}

const jsonFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.printf((info) => {
    const { timestamp, level, message, ...meta } = info
    return JSON.stringify({ timestamp, level, message, ...redact(meta) as object })
  })
)

const devFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.printf((info) => {
    const { timestamp, level, message, ...meta } = info
    const extras = Object.keys(meta).length
      ? '\n' + JSON.stringify(redact(meta), null, 2)
      : ''
    return `${timestamp} ${level}: ${message}${extras}`
  })
)

const transports: winston.transport[] = [
  new winston.transports.Console({
    format: process.env.NODE_ENV === 'production' ? jsonFormat : devFormat,
  }),
]

if (process.env.NODE_ENV === 'production') {
  transports.push(
    new winston.transports.File({
      filename: `${process.env.LOG_DIR || 'logs'}/error.log`,
      level: 'error',
      format: jsonFormat,
    })
  )
}

export const logger = winston.createLogger({
  level: level(),
  transports,
  exitOnError: false,
})

export function skipHealthCheck(req: { path?: string }): boolean {
  return req.path === '/health'
}
