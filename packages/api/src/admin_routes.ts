import { Router, Request, Response } from 'express'
import { z } from 'zod'
import bcrypt from 'bcryptjs'

import { query, queryOne, withTransaction } from '../../config/database'
import { requireStaff, requirePermission } from '../../middleware/rbac'
import { AppError, NotFoundError, ConflictError, success, paginated } from '../../utils/errors'
import { auditLog } from '../../utils/audit'
import { sendEmail } from '../notifications/email.service'
import { generateToken } from '../../utils/encryption'

export const adminRouter = Router()

// All admin routes require staff authentication
adminRouter.use(requireStaff)

// ─── STAFF MANAGEMENT ─────────────────────────────────────────────────────────

adminRouter.get(
  '/staff',
  requirePermission('staff.read'),
  async (req: Request, res: Response) => {
    const { page = '1', limit = '20', role, search, isActive } = req.query as Record<string, string>
    const offset = (parseInt(page) - 1) * parseInt(limit)

    let where = 'WHERE 1=1'
    const params: any[] = []

    if (role)     { params.push(role);     where += ` AND s.role = $${params.length}` }
    if (isActive) { params.push(isActive === 'true'); where += ` AND s.is_active = $${params.length}` }
    if (search) {
      params.push(`%${search}%`)
      where += ` AND (s.first_name ILIKE $${params.length} OR s.last_name ILIKE $${params.length} OR u.email ILIKE $${params.length})`
    }

    params.push(parseInt(limit), offset)
    const staffList = await query(
      `SELECT s.id, s.role, s.first_name, s.last_name, s.employee_id, s.job_title,
              s.department, s.is_active, s.hired_at, s.created_at,
              u.email, u.last_login_at, u.two_fa_enabled
       FROM staff s
       JOIN auth_users u ON u.id = s.auth_user_id
       ${where}
       ORDER BY s.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    )

    const [{ count }] = await query(
      `SELECT COUNT(*) FROM staff s JOIN auth_users u ON u.id = s.auth_user_id ${where}`,
      params.slice(0, -2)
    )
    return paginated(res, staffList, parseInt(count), parseInt(page), parseInt(limit))
  }
)

adminRouter.post(
  '/staff',
  requirePermission('staff.*'),
  async (req: Request, res: Response) => {
    const schema = z.object({
      email:       z.string().email(),
      firstName:   z.string().min(2),
      lastName:    z.string().min(2),
      role:        z.enum(['admin', 'finance', 'hr_payroll', 'customer_care']),
      employeeId:  z.string().min(2),
      jobTitle:    z.string().optional(),
      department:  z.string().optional(),
      phone:       z.string().optional(),
      hiredAt:     z.string().optional(),
    })
    const data = schema.parse(req.body)

    // Only super_admin can create admin role
    if (data.role === 'admin' && req.staffRole !== 'super_admin') {
      throw new AppError('Only Super Admin can create Admin accounts', 403)
    }

    const existing = await queryOne(`SELECT id FROM auth_users WHERE email = $1`, [data.email.toLowerCase()])
    if (existing) throw new ConflictError('Email already in use')

    const tempPassword = `Rheo${generateToken(4).toUpperCase()}!${Math.floor(Math.random() * 900) + 100}`
    const passwordHash = await bcrypt.hash(tempPassword, 12)

    const newStaff = await withTransaction(async (client) => {
      const [authUser] = await client.query(
        `INSERT INTO auth_users (email, password_hash, surface) VALUES ($1, $2, 'staff') RETURNING id`,
        [data.email.toLowerCase(), passwordHash]
      )
      const [staff] = await client.query(
        `INSERT INTO staff
          (auth_user_id, role, first_name, last_name, employee_id, job_title, department, phone, hired_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, role, first_name, last_name, employee_id`,
        [
          authUser.rows[0].id, data.role, data.firstName, data.lastName,
          data.employeeId, data.jobTitle, data.department, data.phone,
          data.hiredAt || null, req.staffId,
        ]
      )
      return staff.rows[0]
    })

    // Send welcome email with temp password
    await sendEmail({
      to: data.email,
      template: 'business_welcome',
      data: {
        firstName: data.firstName,
        role: data.role,
        tempPassword,
        loginUrl: `${process.env.ADMIN_URL}/login`,
        message: 'Please change your password and enable 2FA immediately after logging in.',
      },
    })

    await auditLog({
      actorId: req.staffId,
      actorType: 'staff',
      actorRole: req.staffRole,
      action: 'staff.created',
      resourceType: 'staff',
      resourceId: newStaff.id,
      newData: { email: data.email, role: data.role, employeeId: data.employeeId },
      ip: req.ip,
      surface: 'staff',
    })

    return success(res, newStaff, 201)
  }
)

adminRouter.patch(
  '/staff/:staffId',
  requirePermission('staff.*'),
  async (req: Request, res: Response) => {
    const schema = z.object({
      role:       z.enum(['admin', 'finance', 'hr_payroll', 'customer_care']).optional(),
      firstName:  z.string().min(2).optional(),
      lastName:   z.string().min(2).optional(),
      jobTitle:   z.string().optional(),
      department: z.string().optional(),
      phone:      z.string().optional(),
      isActive:   z.boolean().optional(),
    })
    const data = schema.parse(req.body)

    // Cannot edit own role
    if (req.params.staffId === req.staffId && data.role) {
      throw new AppError('You cannot change your own role', 400)
    }

    const target = await queryOne<any>(`SELECT * FROM staff WHERE id = $1`, [req.params.staffId])
    if (!target) throw new NotFoundError('Staff member')

    // Only super_admin can edit admin role
    if (target.role === 'super_admin' && req.staffRole !== 'super_admin') {
      throw new AppError('Cannot edit Super Admin accounts', 403)
    }

    const fields: string[] = []
    const values: any[] = []

    if (data.role !== undefined)      { fields.push(`role = $${fields.length + 2}`);       values.push(data.role) }
    if (data.firstName !== undefined) { fields.push(`first_name = $${fields.length + 2}`); values.push(data.firstName) }
    if (data.lastName !== undefined)  { fields.push(`last_name = $${fields.length + 2}`);  values.push(data.lastName) }
    if (data.jobTitle !== undefined)  { fields.push(`job_title = $${fields.length + 2}`);  values.push(data.jobTitle) }
    if (data.department !== undefined){ fields.push(`department = $${fields.length + 2}`); values.push(data.department) }
    if (data.phone !== undefined)     { fields.push(`phone = $${fields.length + 2}`);      values.push(data.phone) }
    if (data.isActive !== undefined)  { fields.push(`is_active = $${fields.length + 2}`);  values.push(data.isActive) }

    if (fields.length === 0) return success(res, { message: 'No changes' })

    await query(
      `UPDATE staff SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $1`,
      [req.params.staffId, ...values]
    )

    if (data.isActive === false) {
      await query(`UPDATE auth_users SET is_active = false WHERE id = $1`, [target.auth_user_id])
      // Revoke all sessions
      await query(`UPDATE auth_sessions SET revoked_at = NOW() WHERE user_id = $1`, [target.auth_user_id])
    }

    await auditLog({
      actorId: req.staffId,
      actorType: 'staff',
      actorRole: req.staffRole,
      action: 'staff.updated',
      resourceType: 'staff',
      resourceId: req.params.staffId,
      oldData: target,
      newData: data,
      ip: req.ip,
      surface: 'staff',
    })

    return success(res, { message: 'Staff member updated' })
  }
)

// ─── STAFF PERMISSIONS (granular overrides) ───────────────────────────────────

adminRouter.post(
  '/staff/:staffId/permissions',
  requirePermission('staff.*'),
  async (req: Request, res: Response) => {
    const { permission, granted } = z.object({
      permission: z.string().min(3),
      granted:    z.boolean(),
    }).parse(req.body)

    await query(
      `INSERT INTO staff_permissions (staff_id, permission, granted, granted_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (staff_id, permission) DO UPDATE SET granted = $3, granted_by = $4`,
      [req.params.staffId, permission, granted, req.staffId]
    )

    await auditLog({
      actorId: req.staffId,
      actorType: 'staff',
      actorRole: req.staffRole,
      action: 'staff.permission_changed',
      resourceType: 'staff',
      resourceId: req.params.staffId,
      newData: { permission, granted },
      ip: req.ip,
      surface: 'staff',
    })

    return success(res, { message: `Permission '${permission}' ${granted ? 'granted' : 'revoked'}` })
  }
)

// ─── AUDIT LOG VIEWER ─────────────────────────────────────────────────────────

adminRouter.get(
  '/audit-logs',
  requirePermission('staff.*'),
  async (req: Request, res: Response) => {
    const {
      page = '1', limit = '50',
      actorId, actorType, action,
      resourceType, resourceId,
      from, to,
    } = req.query as Record<string, string>
    const offset = (parseInt(page) - 1) * parseInt(limit)

    let where = 'WHERE 1=1'
    const params: any[] = []

    if (actorId)      { params.push(actorId);      where += ` AND al.actor_id = $${params.length}` }
    if (actorType)    { params.push(actorType);    where += ` AND al.actor_type = $${params.length}` }
    if (action)       { params.push(`%${action}%`); where += ` AND al.action ILIKE $${params.length}` }
    if (resourceType) { params.push(resourceType); where += ` AND al.resource_type = $${params.length}` }
    if (resourceId)   { params.push(resourceId);   where += ` AND al.resource_id = $${params.length}` }
    if (from)         { params.push(from);         where += ` AND al.created_at::date >= $${params.length}` }
    if (to)           { params.push(to);           where += ` AND al.created_at::date <= $${params.length}` }

    params.push(parseInt(limit), offset)
    const logs = await query(
      `SELECT al.id, al.actor_id, al.actor_type, al.actor_role, al.action,
              al.resource_type, al.resource_id, al.ip_address, al.surface,
              al.created_at, al.metadata,
              COALESCE(s.first_name || ' ' || s.last_name, d.first_name || ' ' || d.last_name, 'System') as actor_name
       FROM audit_logs al
       LEFT JOIN staff s ON s.id = al.actor_id AND al.actor_type = 'staff'
       LEFT JOIN drivers d ON d.id = al.actor_id AND al.actor_type = 'driver'
       ${where}
       ORDER BY al.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    )

    const [{ count }] = await query(
      `SELECT COUNT(*) FROM audit_logs al ${where}`, params.slice(0, -2)
    )
    return paginated(res, logs, parseInt(count), parseInt(page), parseInt(limit))
  }
)

// ─── PLATFORM DASHBOARD STATS ─────────────────────────────────────────────────

adminRouter.get(
  '/dashboard',
  requirePermission('analytics.*'),
  async (req: Request, res: Response) => {
    const [jobs]         = await query(`SELECT COUNT(*) FILTER (WHERE status='queued') as queued, COUNT(*) FILTER (WHERE status='in_transit') as in_transit, COUNT(*) FILTER (WHERE status='delivered' AND created_at >= NOW()-INTERVAL '24h') as delivered_today FROM jobs`, [])
    const [drivers]      = await query(`SELECT COUNT(*) FILTER (WHERE status='approved') as approved, COUNT(*) FILTER (WHERE status='pending') as pending, COUNT(*) FILTER (WHERE is_online=true) as online FROM drivers`, [])
    const [businesses]   = await query(`SELECT COUNT(*) FILTER (WHERE status='active') as active, COUNT(*) FILTER (WHERE status='pending') as pending FROM businesses`, [])
    const [revenue]      = await query(`SELECT COALESCE(SUM(rheo_commission_ugx),0) as today FROM jobs WHERE status='delivered' AND created_at::date = CURRENT_DATE`, [])
    const [withdrawals]  = await query(`SELECT COUNT(*) as count, COALESCE(SUM(amount_ugx),0) as total FROM withdrawal_requests WHERE status='pending'`, [])
    const [tickets]      = await query(`SELECT COUNT(*) FILTER (WHERE status='open') as open, COUNT(*) FILTER (WHERE priority='critical' AND status NOT IN ('resolved','closed')) as critical FROM support_tickets`, [])

    const recentActivity = await query(
      `SELECT action, actor_type, actor_role, created_at, resource_type
       FROM audit_logs ORDER BY created_at DESC LIMIT 10`,
      []
    )

    return success(res, {
      jobs, drivers, businesses, revenue, withdrawals, tickets, recentActivity,
    })
  }
)

// ─── HR: PAYROLL ──────────────────────────────────────────────────────────────

adminRouter.get(
  '/payroll',
  requirePermission('payroll.*'),
  async (req: Request, res: Response) => {
    const { period } = req.query as Record<string, string>
    const payroll = await query(
      `SELECT sp.*, s.first_name, s.last_name, s.employee_id, s.role, s.job_title
       FROM staff_payroll sp
       JOIN staff s ON s.id = sp.staff_id
       WHERE ($1::text IS NULL OR TO_CHAR(sp.period_start,'YYYY-MM') = $1)
       ORDER BY s.last_name ASC`,
      [period || null]
    )
    return success(res, payroll)
  }
)

adminRouter.post(
  '/payroll',
  requirePermission('payroll.*'),
  async (req: Request, res: Response) => {
    const schema = z.object({
      staffId:      z.string().uuid(),
      periodStart:  z.string(),
      periodEnd:    z.string(),
      grossSalary:  z.number().positive(),
      deductions:   z.number().default(0),
    })
    const data = schema.parse(req.body)
    const net = data.grossSalary - data.deductions

    const record = await queryOne<any>(
      `INSERT INTO staff_payroll (staff_id, period_start, period_end, gross_salary, deductions, net_salary, processed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [data.staffId, data.periodStart, data.periodEnd, data.grossSalary, data.deductions, net, req.staffId]
    )

    await auditLog({
      actorId: req.staffId,
      actorType: 'staff',
      actorRole: req.staffRole,
      action: 'payroll.created',
      resourceType: 'staff_payroll',
      resourceId: record!.id,
      newData: { staffId: data.staffId, net },
      ip: req.ip,
      surface: 'staff',
    })

    return success(res, record, 201)
  }
)

// ─── KYC REVIEW QUEUE ─────────────────────────────────────────────────────────

adminRouter.get(
  '/kyc/queue',
  requirePermission('drivers.approve'),
  async (req: Request, res: Response) => {
    const pendingDrivers = await query(
      `SELECT d.id, d.first_name, d.last_name, d.phone, d.vehicle_type,
              d.kyc_status, d.status, d.created_at,
              COUNT(dd.id) as doc_count
       FROM drivers d
       LEFT JOIN driver_documents dd ON dd.driver_id = d.id
       WHERE d.kyc_status = 'pending'
       GROUP BY d.id
       ORDER BY d.created_at ASC`,
      []
    )

    const pendingBusinesses = await query(
      `SELECT b.id, b.business_name, b.primary_email, b.kyc_status, b.created_at,
              COUNT(bk.id) as doc_count
       FROM businesses b
       LEFT JOIN business_kyc_docs bk ON bk.business_id = b.id
       WHERE b.kyc_status = 'pending'
       GROUP BY b.id
       ORDER BY b.created_at ASC`,
      []
    )

    return success(res, { drivers: pendingDrivers, businesses: pendingBusinesses })
  }
)

adminRouter.post(
  '/kyc/:type/:id/review',
  requirePermission('drivers.approve'),
  async (req: Request, res: Response) => {
    const { type, id } = req.params
    const { action, notes } = z.object({
      action: z.enum(['approve', 'reject']),
      notes:  z.string().optional(),
    }).parse(req.body)

    if (!['driver', 'business'].includes(type)) throw new AppError('Invalid type', 400)

    const newStatus = action === 'approve' ? 'approved' : 'rejected'
    const table = type === 'driver' ? 'drivers' : 'businesses'

    await query(
      `UPDATE ${table}
       SET kyc_status = $1, kyc_reviewed_by = $2, kyc_reviewed_at = NOW(), kyc_notes = $3
       WHERE id = $4`,
      [newStatus, req.staffId, notes || null, id]
    )

    await auditLog({
      actorId: req.staffId,
      actorType: 'staff',
      actorRole: req.staffRole,
      action: `kyc.${type}_${action}d`,
      resourceType: table,
      resourceId: id,
      newData: { status: newStatus, notes },
      ip: req.ip,
      surface: 'staff',
    })

    return success(res, { message: `KYC ${action}d for ${type}` })
  }
)

// ─── PLATFORM CONFIG ──────────────────────────────────────────────────────────

adminRouter.get(
  '/config',
  requirePermission('staff.*'),
  async (req: Request, res: Response) => {
    return success(res, {
      driverCommissionRate:  parseFloat(process.env.DRIVER_COMMISSION_RATE || '0.01'),
      minWithdrawalUgx:      parseInt(process.env.MIN_WITHDRAWAL_UGX || '50000'),
      defaultBusinessCommission: 0.12,
      supportedPaymentMethods: ['mtn_momo', 'airtel_money', 'visa', 'mastercard'],
      countries: ['Uganda', 'Kenya', 'Tanzania', 'Rwanda'],
    })
  }
)
