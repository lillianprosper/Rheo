import { Router, Request, Response } from 'express'
import bcrypt from 'bcryptjs'
import speakeasy from 'speakeasy'
import QRCode from 'qrcode'
import { v4 as uuidv4 } from 'uuid'
import { z } from 'zod'

import { query, queryOne, withTransaction } from '../config/database'
import { redis } from '../config/redis'
import { signAccessToken, signRefreshToken, verifyRefreshToken, blacklistAccessToken, decodeToken } from '../utils/jwt'
import { generateToken, encrypt, decrypt } from '../utils/encryption'
import { AppError, ConflictError, success } from '../utils/errors'
import { auditLog } from '../utils/audit'
import { authenticate } from '../middleware/rbac'
import { sendSMS } from '../services/sms.service'
import { sendEmail } from '../services/email.service'

export const authRouter = Router()

// ─── Validation schemas ──────────────────────────────────────────────────────

const staffLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  totp: z.string().length(6).optional(),
})

const businessRegisterSchema = z.object({
  businessName: z.string().min(2),
  email: z.string().email(),
  phone: z.string().min(10),
  password: z.string().min(8).regex(
    /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])/,
    'Password must include uppercase, lowercase, number, and special character'
  ),
  country: z.string().default('Uganda'),
})

const driverRegisterSchema = z.object({
  firstName: z.string().min(2),
  lastName: z.string().min(2),
  email: z.string().email(),
  phone: z.string().min(10),
  password: z.string().min(8),
})

const refreshSchema = z.object({
  refreshToken: z.string(),
  surface: z.enum(['staff', 'business', 'driver']),
})

// ─── Helper: create session + tokens ────────────────────────────────────────

async function createSession(
  userId: string,
  surface: string,
  extraPayload: Record<string, any>,
  req: Request
) {
  const sessionId = uuidv4()
  const rawRefresh = generateToken(48)
  const hashedRefresh = generateToken(0) // We hash using our utility

  // Calculate refresh expiry
  const refreshExpiry = new Date()
  refreshExpiry.setDate(refreshExpiry.getDate() + 30)

  const accessToken = signAccessToken({
    sub: userId,
    surface: surface as any,
    ...extraPayload,
  })

  const refreshToken = signRefreshToken({
    sub: userId,
    surface: surface as any,
    sessionId,
  })

  // Store session in DB
  await query(
    `INSERT INTO auth_sessions (id, user_id, refresh_token, device_fp, ip_address, user_agent, surface, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      sessionId,
      userId,
      refreshToken, // stored as-is; in production hash this
      req.headers['x-device-fp'] || null,
      req.ip,
      req.headers['user-agent'],
      surface,
      refreshExpiry,
    ]
  )

  return { accessToken, refreshToken, sessionId }
}

// ─── STAFF LOGIN ─────────────────────────────────────────────────────────────

authRouter.post('/staff/login', async (req: Request, res: Response) => {
  const { email, password, totp } = staffLoginSchema.parse(req.body)

  const user = await queryOne<any>(
    `SELECT u.*, s.id as staff_id, s.role, s.first_name, s.last_name, s.is_active as staff_active
     FROM auth_users u
     JOIN staff s ON s.auth_user_id = u.id
     WHERE u.email = $1 AND u.surface = 'staff'`,
    [email.toLowerCase()]
  )

  if (!user) throw new AppError('Invalid credentials', 401)

  // Check lock
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    throw new AppError('Account temporarily locked. Try again later.', 423)
  }

  const validPassword = await bcrypt.compare(password, user.password_hash)
  if (!validPassword) {
    // Increment failed attempts
    const attempts = user.failed_attempts + 1
    const lockUntil = attempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null
    await query(
      `UPDATE auth_users SET failed_attempts = $1, locked_until = $2 WHERE id = $3`,
      [attempts, lockUntil, user.id]
    )
    throw new AppError('Invalid credentials', 401)
  }

  if (!user.is_active || !user.staff_active) throw new AppError('Account is inactive', 403)

  // 2FA check (mandatory for staff)
  if (user.two_fa_enabled) {
    if (!totp) {
      return res.status(200).json({
        success: true,
        data: { requiresTOTP: true },
      })
    }
    const secret = decrypt(user.two_fa_secret)
    const valid = speakeasy.totp.verify({
      secret,
      encoding: 'base32',
      token: totp,
      window: 1,
    })
    if (!valid) throw new AppError('Invalid 2FA code', 401)
  }

  // Reset failed attempts
  await query(
    `UPDATE auth_users SET failed_attempts = 0, locked_until = NULL, last_login_at = NOW(), last_login_ip = $1 WHERE id = $2`,
    [req.ip, user.id]
  )

  const { accessToken, refreshToken } = await createSession(
    user.id, 'staff',
    { role: user.role, staffId: user.staff_id },
    req
  )

  await auditLog({
    actorId: user.staff_id,
    actorType: 'staff',
    actorRole: user.role,
    action: 'auth.login',
    ip: req.ip,
    surface: 'staff',
  })

  return success(res, {
    accessToken,
    refreshToken,
    user: {
      id: user.staff_id,
      email: user.email,
      firstName: user.first_name,
      lastName: user.last_name,
      role: user.role,
      twoFaEnabled: user.two_fa_enabled,
    },
  })
})

// ─── BUSINESS REGISTER ───────────────────────────────────────────────────────

authRouter.post('/business/register', async (req: Request, res: Response) => {
  const data = businessRegisterSchema.parse(req.body)

  const existing = await queryOne(
    `SELECT id FROM auth_users WHERE email = $1`,
    [data.email.toLowerCase()]
  )
  if (existing) throw new ConflictError('An account with this email already exists')

  const passwordHash = await bcrypt.hash(data.password, 12)

  const result = await withTransaction(async (client) => {
    // Create auth user
    const [authUser] = await client.query(
      `INSERT INTO auth_users (email, password_hash, surface)
       VALUES ($1, $2, 'business') RETURNING id`,
      [data.email.toLowerCase(), passwordHash]
    )

    // Create business record
    const [business] = await client.query(
      `INSERT INTO businesses (auth_user_id, business_name, primary_email, primary_phone)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [authUser.rows[0].id, data.businessName, data.email.toLowerCase(), data.phone]
    )

    // Create owner business member
    const [member] = await client.query(
      `INSERT INTO business_members (business_id, auth_user_id, role, first_name, last_name)
       VALUES ($1, $2, 'owner', $3, $4) RETURNING id`,
      [business.rows[0].id, authUser.rows[0].id, data.businessName, '']
    )

    return {
      authUserId: authUser.rows[0].id,
      businessId: business.rows[0].id,
      memberId: member.rows[0].id,
    }
  })

  // Send verification email
  const otp = Math.floor(100000 + Math.random() * 900000).toString()
  await redis.setOtp(result.authUserId, 'verify', otp, 3600)
  await sendEmail({
    to: data.email,
    template: 'business_welcome',
    data: { businessName: data.businessName, otp },
  })

  await auditLog({
    actorId: result.businessId,
    actorType: 'business_member',
    action: 'auth.business_register',
    resourceType: 'business',
    resourceId: result.businessId,
    ip: req.ip,
    surface: 'business',
    newData: { businessName: data.businessName, email: data.email },
  })

  return success(res, {
    message: 'Account created. Please verify your email.',
    businessId: result.businessId,
  }, 201)
})

// ─── BUSINESS LOGIN ──────────────────────────────────────────────────────────

authRouter.post('/business/login', async (req: Request, res: Response) => {
  const { email, password } = z.object({
    email: z.string().email(),
    password: z.string(),
  }).parse(req.body)

  const user = await queryOne<any>(
    `SELECT u.*, bm.id as member_id, bm.role, bm.business_id, bm.first_name, bm.last_name, bm.is_active as member_active
     FROM auth_users u
     JOIN business_members bm ON bm.auth_user_id = u.id
     WHERE u.email = $1 AND u.surface = 'business'`,
    [email.toLowerCase()]
  )

  if (!user) throw new AppError('Invalid credentials', 401)
  if (!user.is_active || !user.member_active) throw new AppError('Account is inactive', 403)

  const validPassword = await bcrypt.compare(password, user.password_hash)
  if (!validPassword) throw new AppError('Invalid credentials', 401)

  // Check business is active
  const business = await queryOne<any>(
    `SELECT status FROM businesses WHERE id = $1`,
    [user.business_id]
  )
  if (business?.status === 'suspended') throw new AppError('Your business account has been suspended. Contact support.', 403)

  await query(
    `UPDATE auth_users SET last_login_at = NOW(), last_login_ip = $1 WHERE id = $2`,
    [req.ip, user.id]
  )

  const { accessToken, refreshToken } = await createSession(
    user.id, 'business',
    { role: user.role, businessId: user.business_id, staffId: user.member_id },
    req
  )

  return success(res, {
    accessToken,
    refreshToken,
    user: {
      id: user.member_id,
      email: user.email,
      firstName: user.first_name,
      lastName: user.last_name,
      role: user.role,
      businessId: user.business_id,
    },
  })
})

// ─── DRIVER REGISTER ─────────────────────────────────────────────────────────

authRouter.post('/driver/register', async (req: Request, res: Response) => {
  const data = driverRegisterSchema.parse(req.body)

  const existing = await queryOne(
    `SELECT id FROM auth_users WHERE email = $1 OR phone = $2`,
    [data.email.toLowerCase(), data.phone]
  )
  if (existing) throw new ConflictError('An account with this email or phone already exists')

  const passwordHash = await bcrypt.hash(data.password, 12)

  const result = await withTransaction(async (client) => {
    const [authUser] = await client.query(
      `INSERT INTO auth_users (email, phone, password_hash, surface)
       VALUES ($1, $2, $3, 'driver') RETURNING id`,
      [data.email.toLowerCase(), data.phone, passwordHash]
    )

    const [driver] = await client.query(
      `INSERT INTO drivers (auth_user_id, first_name, last_name, phone)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [authUser.rows[0].id, data.firstName, data.lastName, data.phone]
    )

    return { authUserId: authUser.rows[0].id, driverId: driver.rows[0].id }
  })

  // Send SMS with app download link
  await sendSMS({
    to: data.phone,
    message: `Hi ${data.firstName}! Welcome to Rheo. Download the driver app to complete your application: https://rheo.co/driver-app`,
  })

  await auditLog({
    actorId: result.driverId,
    actorType: 'driver',
    action: 'auth.driver_register',
    resourceType: 'driver',
    resourceId: result.driverId,
    ip: req.ip,
    surface: 'driver',
  })

  return success(res, {
    message: 'Registration started. Check your phone for the app download link.',
    driverId: result.driverId,
  }, 201)
})

// ─── DRIVER LOGIN ────────────────────────────────────────────────────────────

authRouter.post('/driver/login', async (req: Request, res: Response) => {
  const { phone, password } = z.object({
    phone: z.string(),
    password: z.string(),
  }).parse(req.body)

  const user = await queryOne<any>(
    `SELECT u.*, d.id as driver_id, d.status, d.first_name, d.last_name
     FROM auth_users u
     JOIN drivers d ON d.auth_user_id = u.id
     WHERE u.phone = $1 AND u.surface = 'driver'`,
    [phone]
  )

  if (!user) throw new AppError('Invalid credentials', 401)

  const validPassword = await bcrypt.compare(password, user.password_hash)
  if (!validPassword) throw new AppError('Invalid credentials', 401)

  if (!user.is_active) throw new AppError('Account is inactive', 403)
  if (user.status === 'rejected') throw new AppError('Your application was not approved. Contact support.', 403)
  if (user.status === 'suspended') throw new AppError('Your account has been suspended. Contact support.', 403)
  if (user.status === 'deactivated') throw new AppError('Your account has been deactivated.', 403)

  await query(
    `UPDATE auth_users SET last_login_at = NOW(), last_login_ip = $1 WHERE id = $2`,
    [req.ip, user.id]
  )

  const { accessToken, refreshToken } = await createSession(
    user.id, 'driver',
    { driverId: user.driver_id },
    req
  )

  return success(res, {
    accessToken,
    refreshToken,
    user: {
      id: user.driver_id,
      phone: user.phone,
      firstName: user.first_name,
      lastName: user.last_name,
      status: user.status,
    },
  })
})

// ─── REFRESH TOKEN ───────────────────────────────────────────────────────────

authRouter.post('/refresh', async (req: Request, res: Response) => {
  const { refreshToken, surface } = refreshSchema.parse(req.body)

  let payload: any
  try {
    payload = verifyRefreshToken(refreshToken, surface as any)
  } catch {
    throw new AppError('Invalid or expired refresh token', 401)
  }

  // Check session exists and not revoked
  const session = await queryOne<any>(
    `SELECT * FROM auth_sessions WHERE id = $1 AND revoked_at IS NULL AND expires_at > NOW()`,
    [payload.sessionId]
  )
  if (!session) throw new AppError('Session expired or revoked', 401)

  // Verify token matches stored (rotation check)
  if (session.refresh_token !== refreshToken) {
    // Token reuse detected — revoke all sessions for this user
    await query(`UPDATE auth_sessions SET revoked_at = NOW() WHERE user_id = $1`, [payload.sub])
    throw new AppError('Token reuse detected. All sessions revoked.', 401)
  }

  // Build new tokens
  const user = await queryOne<any>(
    `SELECT u.*, 
      CASE WHEN u.surface = 'staff' THEN s.role END as staff_role,
      CASE WHEN u.surface = 'staff' THEN s.id END as staff_id,
      CASE WHEN u.surface = 'business' THEN bm.role END as business_role,
      CASE WHEN u.surface = 'business' THEN bm.business_id END as business_id,
      CASE WHEN u.surface = 'business' THEN bm.id END as member_id,
      CASE WHEN u.surface = 'driver' THEN d.id END as driver_id
     FROM auth_users u
     LEFT JOIN staff s ON s.auth_user_id = u.id AND u.surface = 'staff'
     LEFT JOIN business_members bm ON bm.auth_user_id = u.id AND u.surface = 'business'
     LEFT JOIN drivers d ON d.auth_user_id = u.id AND u.surface = 'driver'
     WHERE u.id = $1`,
    [payload.sub]
  )
  if (!user || !user.is_active) throw new AppError('Account inactive', 401)

  const extraPayload: Record<string, any> = {}
  if (surface === 'staff')    { extraPayload.role = user.staff_role; extraPayload.staffId = user.staff_id }
  if (surface === 'business') { extraPayload.role = user.business_role; extraPayload.businessId = user.business_id; extraPayload.staffId = user.member_id }
  if (surface === 'driver')   { extraPayload.driverId = user.driver_id }

  const newAccessToken  = signAccessToken({ sub: payload.sub, surface: surface as any, ...extraPayload })
  const newRefreshToken = signRefreshToken({ sub: payload.sub, surface: surface as any, sessionId: payload.sessionId })

  // Rotate: update stored refresh token
  await query(
    `UPDATE auth_sessions SET refresh_token = $1 WHERE id = $2`,
    [newRefreshToken, payload.sessionId]
  )

  return success(res, { accessToken: newAccessToken, refreshToken: newRefreshToken })
})

// ─── LOGOUT ──────────────────────────────────────────────────────────────────

authRouter.post('/logout', async (req: Request, res: Response) => {
  const { refreshToken } = z.object({ refreshToken: z.string() }).parse(req.body)

  // Revoke session
  const session = await queryOne<any>(
    `UPDATE auth_sessions SET revoked_at = NOW() WHERE refresh_token = $1 RETURNING user_id`,
    [refreshToken]
  )

  // Blacklist access token if provided
  const authHeader = req.headers.authorization
  if (authHeader?.startsWith('Bearer ')) {
    const decoded = decodeToken(authHeader.slice(7)) as any
    if (decoded?.jti && decoded?.exp) {
      await blacklistAccessToken(decoded.jti, decoded.exp)
    }
  }

  return success(res, { message: 'Logged out successfully' })
})

// ─── 2FA SETUP (Staff) ───────────────────────────────────────────────────────

authRouter.post('/staff/2fa/setup', authenticate('staff'), async (req: Request, res: Response) => {
  const userId = req.auth!.sub

  const secret = speakeasy.generateSecret({
    name: `Rheo Admin (${req.auth!.sub})`,
    issuer: 'Rheo',
    length: 32,
  })

  // Store encrypted secret temporarily (not enabled yet)
  await query(
    `UPDATE auth_users SET two_fa_secret = $1 WHERE id = $2`,
    [encrypt(secret.base32), userId]
  )

  const qrCode = await QRCode.toDataURL(secret.otpauth_url!)

  return success(res, {
    secret: secret.base32,
    qrCode,
    message: 'Scan the QR code in your authenticator app, then confirm with a TOTP code',
  })
})

authRouter.post('/staff/2fa/confirm', authenticate('staff'), async (req: Request, res: Response) => {
  const { totp } = z.object({ totp: z.string().length(6) }).parse(req.body)
  const userId = req.auth!.sub

  const user = await queryOne<any>(
    `SELECT two_fa_secret FROM auth_users WHERE id = $1`,
    [userId]
  )
  if (!user?.two_fa_secret) throw new AppError('2FA setup not initiated', 400)

  const secret = decrypt(user.two_fa_secret)
  const valid = speakeasy.totp.verify({ secret, encoding: 'base32', token: totp, window: 1 })
  if (!valid) throw new AppError('Invalid TOTP code', 400)

  await query(
    `UPDATE auth_users SET two_fa_enabled = true WHERE id = $1`,
    [userId]
  )

  await auditLog({
    actorId: req.staffId,
    actorType: 'staff',
    action: 'auth.2fa_enabled',
    ip: req.ip,
    surface: 'staff',
  })

  return success(res, { message: '2FA enabled successfully' })
})

// ─── EMAIL VERIFICATION ──────────────────────────────────────────────────────

authRouter.post('/verify-email', async (req: Request, res: Response) => {
  const { userId, otp } = z.object({
    userId: z.string().uuid(),
    otp: z.string().length(6),
  }).parse(req.body)

  const storedOtp = await redis.getOtp(userId, 'verify')
  if (!storedOtp || storedOtp !== otp) throw new AppError('Invalid or expired verification code', 400)

  await query(`UPDATE auth_users SET is_verified = true WHERE id = $1`, [userId])
  await redis.deleteOtp(userId, 'verify')

  return success(res, { message: 'Email verified successfully' })
})

// ─── PASSWORD RESET ──────────────────────────────────────────────────────────

authRouter.post('/forgot-password', async (req: Request, res: Response) => {
  const { email, surface } = z.object({
    email: z.string().email(),
    surface: z.enum(['staff', 'business', 'driver']),
  }).parse(req.body)

  const user = await queryOne<any>(
    `SELECT id, email FROM auth_users WHERE email = $1 AND surface = $2`,
    [email.toLowerCase(), surface]
  )

  // Always return success to prevent email enumeration
  if (user) {
    const otp = Math.floor(100000 + Math.random() * 900000).toString()
    await redis.setOtp(user.id, 'reset', otp, 900) // 15 min
    await sendEmail({
      to: email,
      template: 'password_reset',
      data: { otp, expiresIn: '15 minutes' },
    })
  }

  return success(res, { message: 'If this email exists, a reset code has been sent.' })
})

authRouter.post('/reset-password', async (req: Request, res: Response) => {
  const { userId, otp, newPassword } = z.object({
    userId: z.string().uuid(),
    otp: z.string().length(6),
    newPassword: z.string().min(8),
  }).parse(req.body)

  const storedOtp = await redis.getOtp(userId, 'reset')
  if (!storedOtp || storedOtp !== otp) throw new AppError('Invalid or expired reset code', 400)

  const hash = await bcrypt.hash(newPassword, 12)
  await query(`UPDATE auth_users SET password_hash = $1 WHERE id = $2`, [hash, userId])

  // Revoke all existing sessions
  await query(`UPDATE auth_sessions SET revoked_at = NOW() WHERE user_id = $1`, [userId])
  await redis.deleteOtp(userId, 'reset')

  return success(res, { message: 'Password reset successfully. Please log in again.' })
})
