import { Request, Response, NextFunction } from 'express'
import { verifyAccessToken, Surface, AccessTokenPayload } from '../utils/jwt'
import { redis } from '../config/redis'
import { query } from '../config/database'
import { AppError } from '../utils/errors'
import { auditLog } from '../utils/audit'

// Extend Express Request with auth context
declare global {
  namespace Express {
    interface Request {
      auth?: AccessTokenPayload
      staffRole?: string
      businessId?: string
      driverId?: string
      staffId?: string
    }
  }
}

// ─── Role permission matrix ────────────────────────────────────────────────
// Each role gets a whitelist of permission strings.
// '*' means full access to that namespace.

const STAFF_PERMISSIONS: Record<string, string[]> = {
  super_admin: ['*'],
  admin: [
    'drivers.*', 'businesses.*', 'jobs.*', 'support.*',
    'analytics.*', 'notifications.*', 'staff.read',
  ],
  finance: [
    'transactions.*', 'withdrawals.*', 'invoices.*',
    'subscriptions.*', 'analytics.finance', 'drivers.read',
    'businesses.read', 'jobs.read',
  ],
  hr_payroll: [
    'staff.*', 'payroll.*', 'drivers.read',
  ],
  customer_care: [
    'support.*', 'drivers.read', 'businesses.read',
    'jobs.read', 'notifications.send',
  ],
}

const BUSINESS_PERMISSIONS: Record<string, string[]> = {
  owner: ['*'],
  ops_manager: [
    'jobs.*', 'deliveries.*', 'drivers.read',
    'analytics.read', 'support.*', 'notifications.read',
  ],
  dispatcher: [
    'jobs.create', 'jobs.read', 'jobs.update',
    'deliveries.read', 'support.create', 'support.read',
  ],
}

function hasPermission(role: string, roleMap: Record<string, string[]>, required: string): boolean {
  const perms = roleMap[role] || []
  if (perms.includes('*')) return true
  if (perms.includes(required)) return true

  // Namespace wildcard: 'drivers.*' covers 'drivers.read'
  const [ns] = required.split('.')
  return perms.includes(`${ns}.*`)
}

// ─── Auth middleware factory ────────────────────────────────────────────────

export function authenticate(surface: Surface) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
      throw new AppError('Missing or invalid authorization header', 401)
    }

    const token = authHeader.slice(7)

    let payload: AccessTokenPayload
    try {
      payload = verifyAccessToken(token, surface)
    } catch (err: any) {
      if (err.name === 'TokenExpiredError') throw new AppError('Token expired', 401)
      throw new AppError('Invalid token', 401)
    }

    // Check token blacklist
    if (await redis.isBlacklisted(payload.jti)) {
      throw new AppError('Token has been revoked', 401)
    }

    // Verify user is still active in DB
    const user = await query(
      `SELECT id, is_active, surface FROM auth_users WHERE id = $1`,
      [payload.sub]
    )
    if (!user[0] || !user[0].is_active) {
      throw new AppError('Account is inactive', 401)
    }
    if (user[0].surface !== surface) {
      throw new AppError('Token not valid for this surface', 403)
    }

    // Attach auth context to request
    req.auth = payload
    req.businessId = payload.businessId
    req.driverId = payload.driverId
    req.staffId = payload.staffId
    req.staffRole = payload.role

    next()
  }
}

// ─── Permission guard ────────────────────────────────────────────────────────

export function requirePermission(permission: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth) throw new AppError('Unauthenticated', 401)

    const { surface, role } = req.auth

    let allowed = false

    if (surface === 'staff' && role) {
      // Check granular DB override first
      const override = await query(
        `SELECT granted FROM staff_permissions WHERE staff_id = $1 AND permission = $2`,
        [req.staffId, permission]
      )
      if (override[0]) {
        allowed = override[0].granted
      } else {
        allowed = hasPermission(role, STAFF_PERMISSIONS, permission)
      }
    } else if (surface === 'business' && role) {
      allowed = hasPermission(role, BUSINESS_PERMISSIONS, permission)
    } else if (surface === 'driver') {
      // Drivers only access driver-namespaced routes — no role check needed here
      // Route-level guards handle driver-specific resource ownership
      allowed = true
    }

    if (!allowed) {
      await auditLog({
        actorId: req.auth.sub,
        actorType: surface === 'staff' ? 'staff' : surface === 'business' ? 'business_member' : 'driver',
        actorRole: role,
        action: `PERMISSION_DENIED:${permission}`,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        surface,
      })
      throw new AppError(`Insufficient permissions: ${permission}`, 403)
    }

    next()
  }
}

// ─── Role shortcuts ──────────────────────────────────────────────────────────

export const requireStaff    = authenticate('staff')
export const requireBusiness = authenticate('business')
export const requireDriver   = authenticate('driver')

export const requireAdmin    = [requireStaff, requirePermission('drivers.*')]
export const requireFinance  = [requireStaff, requirePermission('transactions.*')]
export const requireHR       = [requireStaff, requirePermission('staff.*')]
export const requireSupport  = [requireStaff, requirePermission('support.*')]

// ─── Resource ownership guards ───────────────────────────────────────────────

// Ensure a driver can only access their own resources
export function requireOwnDriver(req: Request, res: Response, next: NextFunction) {
  const { driverId } = req.params
  if (req.driverId !== driverId) {
    throw new AppError('Access denied to this driver resource', 403)
  }
  next()
}

// Ensure a business member can only access their own business
export function requireOwnBusiness(req: Request, res: Response, next: NextFunction) {
  const { businessId } = req.params
  if (req.businessId !== businessId) {
    throw new AppError('Access denied to this business resource', 403)
  }
  next()
}
