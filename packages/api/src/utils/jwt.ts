import jwt, { JwtPayload, SignOptions } from 'jsonwebtoken'
import { AppError } from './errors'

export type Surface = 'staff' | 'business' | 'driver'

export interface AccessTokenPayload extends JwtPayload {
  sub: string
  surface: Surface
  role?: string
  staffId?: string
  businessId?: string
  driverId?: string
  jti: string
}

export interface RefreshTokenPayload extends JwtPayload {
  sub: string
  surface: Surface
  sessionId: string
}

function getAccessSecret(surface: Surface): string {
  const key = process.env.JWT_ACCESS_SECRET
  if (!key) throw new Error('JWT_ACCESS_SECRET is not set')
  return `${surface}:${key}`
}

function getRefreshSecret(surface: Surface): string {
  const key = process.env.JWT_REFRESH_SECRET
  if (!key) throw new Error('JWT_REFRESH_SECRET is not set')
  return `${surface}:${key}`
}

export function signAccessToken(payload: Omit<AccessTokenPayload, 'jti'>): string {
  const { sub, surface, ...rest } = payload
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const jti: string = require('crypto').randomUUID()
  const expiry = process.env.JWT_ACCESS_EXPIRY || '15m'
  const options: SignOptions = {
    expiresIn: expiry as SignOptions['expiresIn'],
    issuer: 'rheo-api',
    audience: surface,
    jwtid: jti,
  }
  return jwt.sign({ sub, surface, ...rest }, getAccessSecret(surface), options)
}

export function signRefreshToken(payload: RefreshTokenPayload): string {
  const { sub, surface, sessionId } = payload
  const expiry = process.env.JWT_REFRESH_EXPIRY || '30d'
  const options: SignOptions = {
    expiresIn: expiry as SignOptions['expiresIn'],
    issuer: 'rheo-api',
    audience: `${surface}:refresh`,
  }
  return jwt.sign({ sub, surface, sessionId }, getRefreshSecret(surface), options)
}

export function verifyAccessToken(token: string, surface: Surface): AccessTokenPayload {
  try {
    const payload = jwt.verify(token, getAccessSecret(surface), {
      issuer: 'rheo-api',
      audience: surface,
    }) as AccessTokenPayload
    if (payload.surface !== surface) throw new AppError('Token surface mismatch', 403)
    return payload
  } catch (err: unknown) {
    if (err instanceof AppError) throw err
    const e = err as { name?: string }
    if (e.name === 'TokenExpiredError') throw new AppError('Token expired', 401, 'TOKEN_EXPIRED')
    if (e.name === 'JsonWebTokenError') throw new AppError('Invalid token', 401, 'INVALID_TOKEN')
    throw new AppError('Token verification failed', 401)
  }
}

export function verifyRefreshToken(token: string, surface: Surface): RefreshTokenPayload {
  try {
    return jwt.verify(token, getRefreshSecret(surface), {
      issuer: 'rheo-api',
      audience: `${surface}:refresh`,
    }) as RefreshTokenPayload
  } catch (err: unknown) {
    const e = err as { name?: string }
    if (e.name === 'TokenExpiredError') throw new AppError('Refresh token expired', 401, 'TOKEN_EXPIRED')
    throw new AppError('Invalid refresh token', 401, 'INVALID_TOKEN')
  }
}

export function decodeToken(token: string): JwtPayload | null {
  return jwt.decode(token) as JwtPayload | null
}

export async function blacklistAccessToken(jti: string, exp: number): Promise<void> {
  const { redis } = await import('../config/redis')
  const ttl = exp - Math.floor(Date.now() / 1000)
  if (ttl > 0) await redis.blacklistToken(jti, ttl)
}
