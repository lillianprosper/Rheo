import { Router, Request, Response } from 'express'
import { z } from 'zod'
import bcrypt from 'bcryptjs'

import { query, queryOne, withTransaction } from '../config/database'
import { authenticate, requirePermission } from '../middleware/rbac'
import { AppError, ConflictError, NotFoundError, success, paginated } from '../utils/errors'
import { encrypt } from '../utils/encryption'
import { auditLog } from '../utils/audit'
import { generateToken } from '../utils/encryption'
import { sendNotification, markAllNotificationsRead } from '../services/notification.service'
import { emails } from '../services/email.service'

export const businessRouter = Router()

const requireBusiness = authenticate('business')
const requireStaff    = authenticate('staff')

// ─── BUSINESS: Own profile ────────────────────────────────────────────────────

businessRouter.get('/me', requireBusiness, async (req: Request, res: Response) => {
  const business = await queryOne<Record<string, unknown>>(
    `SELECT b.id, b.business_name, b.trading_name, b.registration_no,
            b.industry, b.website, b.logo_url, b.status,
            b.primary_email, b.primary_phone,
            b.address_line1, b.address_line2, b.city, b.country,
            b.kyc_status, b.plan, b.plan_billing,
            b.plan_started_at, b.plan_renews_at, b.commission_rate,
            bs.status as subscription_status,
            sp.display_name as plan_display_name,
            sp.max_jobs_per_month, sp.max_team_members,
            (SELECT COUNT(*) FROM jobs WHERE business_id = b.id
             AND created_at >= date_trunc('month', NOW())) as jobs_this_month
     FROM businesses b
     LEFT JOIN business_subscriptions bs ON bs.business_id = b.id AND bs.status = 'active'
     LEFT JOIN subscription_plans sp ON sp.id = bs.plan_id
     WHERE b.id = $1`,
    [req.businessId]
  )
  if (!business) throw new NotFoundError('Business')
  return success(res, business)
})

// ─── BUSINESS: Update profile ─────────────────────────────────────────────────

businessRouter.patch('/me', requireBusiness, async (req: Request, res: Response) => {
  const schema = z.object({
    tradingName:   z.string().optional(),
    industry:      z.string().optional(),
    website:       z.string().url().optional(),
    primaryPhone:  z.string().min(9).optional(),
    addressLine1:  z.string().optional(),
    addressLine2:  z.string().optional(),
    city:          z.string().optional(),
  })
  const data = schema.parse(req.body)

  const setClause = Object.entries({
    trading_name:  data.tradingName,
    industry:      data.industry,
    website:       data.website,
    primary_phone: data.primaryPhone,
    address_line1: data.addressLine1,
    address_line2: data.addressLine2,
    city:          data.city,
  })
    .filter(([, v]) => v !== undefined)
    .map(([k, v], i) => `${k} = $${i + 2}`)
    .join(', ')

  if (!setClause) throw new AppError('No fields to update', 400)

  const values = Object.values(data).filter((v) => v !== undefined)
  await query(`UPDATE businesses SET ${setClause} WHERE id = $1`, [req.businessId, ...values])

  await auditLog({
    actorId: req.staffId, actorType: 'business_member',
    action: 'business.profile_updated',
    resourceType: 'business', resourceId: req.businessId,
    newData: data,
  })

  return success(res, { message: 'Profile updated.' })
})

// ─── BUSINESS: Team members ───────────────────────────────────────────────────

businessRouter.get('/me/team', requireBusiness, async (req: Request, res: Response) => {
  const members = await query(
    `SELECT bm.id, bm.role, bm.first_name, bm.last_name,
            bm.phone, bm.avatar_url, bm.is_active, bm.created_at,
            u.email, u.last_login_at
     FROM business_members bm
     JOIN auth_users u ON u.id = bm.auth_user_id
     WHERE bm.business_id = $1
     ORDER BY bm.created_at ASC`,
    [req.businessId]
  )
  return success(res, members)
})

// ─── BUSINESS: Invite team member ─────────────────────────────────────────────

businessRouter.post(
  '/me/team/invite',
  requireBusiness,
  requirePermission('jobs.*'), // owner / ops_manager only
  async (req: Request, res: Response) => {
    const schema = z.object({
      email:     z.string().email(),
      firstName: z.string().min(2),
      lastName:  z.string().min(2),
      role:      z.enum(['ops_manager', 'dispatcher']),
      phone:     z.string().optional(),
    })
    const data = schema.parse(req.body)

    // Only owner can invite ops_manager
    if (data.role === 'ops_manager' && req.auth!.role !== 'owner') {
      throw new AppError('Only the business owner can invite an Operations Manager', 403)
    }

    // Check plan team limit
    const business = await queryOne<{ max_team_members: number | null }>(
      `SELECT sp.max_team_members
       FROM businesses b
       LEFT JOIN business_subscriptions bs ON bs.business_id = b.id AND bs.status = 'active'
       LEFT JOIN subscription_plans sp ON sp.id = bs.plan_id
       WHERE b.id = $1`,
      [req.businessId]
    )

    if (business?.max_team_members) {
      const [{ count }] = await query<{ count: string }>(
        `SELECT COUNT(*) FROM business_members WHERE business_id = $1 AND is_active = true`,
        [req.businessId]
      )
      if (parseInt(count) >= business.max_team_members) {
        throw new AppError(
          `Team member limit (${business.max_team_members}) reached. Upgrade your plan.`,
          429, 'TEAM_LIMIT_REACHED'
        )
      }
    }

    const existing = await queryOne(
      `SELECT id FROM auth_users WHERE email = $1`, [data.email.toLowerCase()]
    )
    if (existing) throw new ConflictError('An account with this email already exists')

    // Generate temporary password — user must change on first login
    const tempPassword = generateToken(8)
    const passwordHash = await bcrypt.hash(tempPassword, 12)

    const result = await withTransaction(async (client) => {
      const [authUser] = (await client.query(
        `INSERT INTO auth_users (email, password_hash, surface, is_verified)
         VALUES ($1,$2,'business',true) RETURNING id`,
        [data.email.toLowerCase(), passwordHash]
      )).rows

      const [member] = (await client.query(
        `INSERT INTO business_members
           (business_id, auth_user_id, role, first_name, last_name, phone, invited_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [req.businessId, authUser.id, data.role, data.firstName, data.lastName,
         data.phone ?? null, req.staffId]
      )).rows

      return { authUserId: authUser.id, memberId: member.id }
    })

    await emails.staffInvite(data.email, {
      firstName:    data.firstName,
      tempPassword,
      role:         data.role,
    })

    await auditLog({
      actorId: req.staffId, actorType: 'business_member',
      action: 'business.team_member_invited',
      resourceType: 'business_member', resourceId: result.memberId,
      newData: { email: data.email, role: data.role },
    })

    return success(res, { memberId: result.memberId }, 201)
  }
)

// ─── BUSINESS: Remove team member ─────────────────────────────────────────────

businessRouter.delete(
  '/me/team/:id',
  requireBusiness,
  requirePermission('jobs.*'),
  async (req: Request, res: Response) => {
    if (req.auth!.role !== 'owner') {
      throw new AppError('Only the business owner can remove team members', 403)
    }
    // Cannot remove yourself
    if (req.params.id === req.staffId) {
      throw new AppError('You cannot remove yourself from the team', 400)
    }

    const member = await queryOne<{ id: string }>(
      `SELECT id FROM business_members WHERE id = $1 AND business_id = $2`,
      [req.params.id, req.businessId]
    )
    if (!member) throw new NotFoundError('Team member')

    await query(
      `UPDATE business_members SET is_active = false WHERE id = $1`,
      [req.params.id]
    )
    await query(
      `UPDATE auth_users SET is_active = false
       WHERE id = (SELECT auth_user_id FROM business_members WHERE id = $1)`,
      [req.params.id]
    )

    await auditLog({
      actorId: req.staffId, actorType: 'business_member',
      action: 'business.team_member_removed',
      resourceType: 'business_member', resourceId: req.params.id,
    })

    return success(res, { message: 'Team member removed.' })
  }
)

// ─── BUSINESS: Add payment method ─────────────────────────────────────────────

businessRouter.post('/me/payment-methods', requireBusiness, async (req: Request, res: Response) => {
  const schema = z.object({
    type:          z.enum(['mtn_momo', 'airtel_money', 'visa', 'mastercard']),
    accountNumber: z.string().min(9),
    accountName:   z.string().min(2),
    isDefault:     z.boolean().default(false),
  })
  const data = schema.parse(req.body)

  const encryptedAccount = encrypt(data.accountNumber)

  if (data.isDefault) {
    await query(
      `UPDATE business_payment_methods SET is_default = false WHERE business_id = $1`,
      [req.businessId]
    )
  }

  const last4 = data.accountNumber.slice(-4).padStart(data.accountNumber.length, '*')
  const displayName = `${data.type.replace('_', ' ').toUpperCase()} — ${last4}`

  const pm = await queryOne<{ id: string }>(
    `INSERT INTO business_payment_methods
       (business_id, type, display_name, account_number, account_name, is_default)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [req.businessId, data.type, displayName, encryptedAccount, data.accountName, data.isDefault]
  )

  return success(res, { paymentMethodId: pm!.id }, 201)
})

// ─── BUSINESS: Notifications ──────────────────────────────────────────────────

businessRouter.get('/me/notifications', requireBusiness, async (req: Request, res: Response) => {
  const { page = '1', limit = '20', unreadOnly } = req.query as Record<string, string>
  const offset = (parseInt(page) - 1) * parseInt(limit)

  let where = 'WHERE recipient_id = $1 AND recipient_type = \'business_member\''
  if (unreadOnly === 'true') where += ' AND read_at IS NULL'

  const notifications = await query(
    `SELECT id, type, title, body, data, read_at, created_at
     FROM notifications ${where}
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [req.staffId, parseInt(limit), offset]
  )

  const [{ count }] = await query<{ count: string }>(
    `SELECT COUNT(*) FROM notifications ${where}`, [req.staffId]
  )
  const [{ unread }] = await query<{ unread: string }>(
    `SELECT COUNT(*) as unread FROM notifications
     WHERE recipient_id = $1 AND recipient_type = 'business_member' AND read_at IS NULL`,
    [req.staffId]
  )

  res.setHeader('X-Unread-Count', unread)
  return paginated(res, notifications, parseInt(count), parseInt(page), parseInt(limit))
})

businessRouter.post('/me/notifications/read-all', requireBusiness, async (req: Request, res: Response) => {
  const count = await markAllNotificationsRead(req.staffId!, 'business_member')
  return success(res, { markedRead: count })
})

// ─── STAFF: List businesses ───────────────────────────────────────────────────

businessRouter.get(
  '/',
  requireStaff,
  requirePermission('businesses.read'),
  async (req: Request, res: Response) => {
    const { page = '1', limit = '20', status, plan, search } = req.query as Record<string, string>
    const offset = (parseInt(page) - 1) * parseInt(limit)

    const params: unknown[] = []
    let where = 'WHERE 1=1'
    if (status) { params.push(status); where += ` AND b.status = $${params.length}` }
    if (plan)   { params.push(plan);   where += ` AND b.plan = $${params.length}` }
    if (search) {
      params.push(`%${search}%`)
      where += ` AND (b.business_name ILIKE $${params.length} OR b.primary_email ILIKE $${params.length})`
    }

    params.push(parseInt(limit), offset)
    const businesses = await query(
      `SELECT b.id, b.business_name, b.primary_email, b.primary_phone,
              b.status, b.plan, b.kyc_status, b.city,
              b.plan_renews_at, b.created_at,
              (SELECT COUNT(*) FROM jobs WHERE business_id = b.id) as total_jobs
       FROM businesses b
       ${where}
       ORDER BY b.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    )

    const [{ count }] = await query<{ count: string }>(
      `SELECT COUNT(*) FROM businesses b ${where}`, params.slice(0, -2)
    )

    return paginated(res, businesses, parseInt(count), parseInt(page), parseInt(limit))
  }
)

// ─── STAFF: Approve / suspend business ───────────────────────────────────────

businessRouter.post(
  '/:id/status',
  requireStaff,
  requirePermission('businesses.*'),
  async (req: Request, res: Response) => {
    const { status, reason } = z.object({
      status: z.enum(['active', 'suspended', 'churned']),
      reason: z.string().optional(),
    }).parse(req.body)

    const business = await queryOne<{ id: string; business_name: string; primary_email: string }>(
      `SELECT id, business_name, primary_email FROM businesses WHERE id = $1`,
      [req.params.id]
    )
    if (!business) throw new NotFoundError('Business')

    await query(
      `UPDATE businesses SET status = $1 WHERE id = $2`,
      [status, req.params.id]
    )

    await auditLog({
      actorId: req.staffId, actorType: 'staff', actorRole: req.staffRole,
      action: `business.status_changed.${status}`,
      resourceType: 'business', resourceId: req.params.id,
      newData: { status, reason },
    })

    return success(res, { status })
  }
)
