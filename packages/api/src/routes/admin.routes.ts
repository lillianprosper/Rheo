import { Router, Request, Response } from 'express'
import { z } from 'zod'
import bcrypt from 'bcryptjs'

import { query, queryOne, withTransaction } from '../config/database'
import { authenticate, requirePermission } from '../middleware/rbac'
import { NotFoundError, AppError, ConflictError, success, paginated } from '../utils/errors'
import { auditLog } from '../utils/audit'
import { getPresignedUrl } from '../services/storage.service'
import { sendEmail } from '../services/email.service'
import { generateToken } from '../utils/encryption'

export const adminRouter = Router()
const requireStaff = authenticate('staff')

// All admin routes require staff auth
adminRouter.use(requireStaff)

// ─── ADMIN: Platform dashboard ────────────────────────────────────────────────

adminRouter.get(
  '/dashboard',
  requirePermission('analytics.*'),
  async (req: Request, res: Response) => {
    const kpis = await queryOne<Record<string, unknown>>(
      `SELECT
         (SELECT COUNT(*) FROM drivers    WHERE status = 'approved')           as approved_drivers,
         (SELECT COUNT(*) FROM drivers    WHERE status = 'pending')            as pending_drivers,
         (SELECT COUNT(*) FROM drivers    WHERE is_online = true)              as online_drivers,
         (SELECT COUNT(*) FROM businesses WHERE status = 'active')            as active_businesses,
         (SELECT COUNT(*) FROM businesses WHERE status = 'pending')           as pending_businesses,
         (SELECT COUNT(*) FROM jobs WHERE DATE(created_at) = CURRENT_DATE)    as jobs_today,
         (SELECT COUNT(*) FROM jobs WHERE status IN ('queued','assigned','in_transit')) as live_jobs,
         (SELECT COALESCE(SUM(rheo_commission_ugx),0) FROM jobs
          WHERE status = 'delivered'
          AND DATE(delivered_at) = CURRENT_DATE)                              as commission_today_ugx,
         (SELECT COUNT(*) FROM withdrawal_requests WHERE status = 'pending')  as pending_withdrawals,
         (SELECT COUNT(*) FROM support_tickets    WHERE status = 'open')      as open_tickets,
         (SELECT COUNT(*) FROM drivers WHERE kyc_status = 'pending')          as driver_kyc_pending,
         (SELECT COUNT(*) FROM businesses WHERE kyc_status = 'pending')       as business_kyc_pending`
    )
    return success(res, kpis)
  }
)

// ─── ADMIN: KYC queue ─────────────────────────────────────────────────────────

adminRouter.get(
  '/kyc/queue',
  requirePermission('drivers.*'),
  async (req: Request, res: Response) => {
    const { type = 'driver' } = req.query as { type?: string }

    if (type === 'driver') {
      const drivers = await query(
        `SELECT d.id, d.first_name, d.last_name, d.phone, d.status,
                d.kyc_status, d.vehicle_type, d.plate_number, d.created_at,
                u.email,
                (SELECT COUNT(*) FROM driver_documents WHERE driver_id = d.id) as doc_count
         FROM drivers d
         JOIN auth_users u ON u.id = d.auth_user_id
         WHERE d.kyc_status = 'pending'
         ORDER BY d.created_at ASC`,
        []
      )
      return success(res, { type: 'driver', queue: drivers })
    }

    if (type === 'business') {
      const businesses = await query(
        `SELECT b.id, b.business_name, b.primary_email, b.primary_phone,
                b.kyc_status, b.status, b.created_at,
                (SELECT COUNT(*) FROM business_kyc_docs WHERE business_id = b.id) as doc_count
         FROM businesses b
         WHERE b.kyc_status = 'pending'
         ORDER BY b.created_at ASC`,
        []
      )
      return success(res, { type: 'business', queue: businesses })
    }

    throw new AppError('Invalid type. Must be driver or business', 400)
  }
)

// ─── ADMIN: Review KYC ────────────────────────────────────────────────────────

adminRouter.post(
  '/kyc/:type/:id/review',
  requirePermission('drivers.*'),
  async (req: Request, res: Response) => {
    const { type, id } = req.params
    const { action, notes } = z.object({
      action: z.enum(['approve', 'reject']),
      notes:  z.string().optional(),
    }).parse(req.body)

    if (!['driver', 'business'].includes(type)) {
      throw new AppError('Invalid KYC type', 400)
    }

    const newStatus = action === 'approve' ? 'approved' : 'rejected'
    const table     = type === 'driver' ? 'drivers' : 'businesses'

    const entity = await queryOne(`SELECT id FROM ${table} WHERE id = $1`, [id])
    if (!entity) throw new NotFoundError(type === 'driver' ? 'Driver' : 'Business')

    await query(
      `UPDATE ${table}
       SET kyc_status = $1,
           kyc_reviewed_by = $2,
           kyc_reviewed_at = NOW(),
           kyc_notes = $3,
           status = CASE
             WHEN $1 = 'approved' AND status = 'pending' THEN
               CASE WHEN '${type}' = 'driver' THEN 'approved'::driver_status
                    ELSE 'active'::business_status END
             ELSE status
           END
       WHERE id = $4`,
      [newStatus, req.staffId, notes ?? null, id]
    )

    // Fetch presigned URLs for reviewed documents
    let documents: unknown[] = []
    if (type === 'driver') {
      const docs = await query<{ id: string; file_url: string; doc_type: string; file_name: string }>(
        `SELECT id, file_url, doc_type, file_name FROM driver_documents WHERE driver_id = $1`,
        [id]
      )
      documents = await Promise.all(
        docs.map(async (d) => ({
          ...d,
          presignedUrl: await getPresignedUrl(d.file_url, 3600),
        }))
      )
    }

    await auditLog({
      actorId: req.staffId, actorType: 'staff', actorRole: req.staffRole,
      action:  `kyc.${type}.${action}`,
      resourceType: type, resourceId: id,
      newData: { kycStatus: newStatus, notes },
    })

    return success(res, { kycStatus: newStatus, documents })
  }
)

// ─── ADMIN: Staff management (list, create, edit) ─────────────────────────────

adminRouter.get(
  '/staff',
  requirePermission('staff.read'),
  async (req: Request, res: Response) => {
    const { page = '1', limit = '20', role, search, isActive } = req.query as Record<string, string>
    const offset = (parseInt(page) - 1) * parseInt(limit)

    let where = 'WHERE 1=1'
    const params: unknown[] = []

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

    const [{ count }] = await query<{ count: string }>(
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
      const authUser = await client.query(
        `INSERT INTO auth_users (email, password_hash, surface) VALUES ($1, $2, 'staff') RETURNING id`,
        [data.email.toLowerCase(), passwordHash]
      )
      const staff = await client.query(
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
      template: 'staff_invite',
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
    const values: unknown[] = []

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
    })

    return success(res, { message: 'Staff member updated' })
  }
)

// ─── ADMIN: Staff permissions (granular overrides) ────────────────────────────

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
    })

    return success(res, { message: `Permission '${permission}' ${granted ? 'granted' : 'revoked'}` })
  }
)

// ─── ADMIN: Audit logs ────────────────────────────────────────────────────────

adminRouter.get(
  '/audit-logs',
  requirePermission('staff.read'),
  async (req: Request, res: Response) => {
    const {
      page = '1', limit = '50',
      actorId, actorType, action, resourceType, resourceId,
    } = req.query as Record<string, string>
    const offset = (parseInt(page) - 1) * parseInt(limit)

    const params: unknown[] = []
    let where = 'WHERE 1=1'

    if (actorId)      { params.push(actorId);      where += ` AND actor_id = $${params.length}` }
    if (actorType)    { params.push(actorType);    where += ` AND actor_type = $${params.length}` }
    if (action)       { params.push(`%${action}%`);where += ` AND action ILIKE $${params.length}` }
    if (resourceType) { params.push(resourceType); where += ` AND resource_type = $${params.length}` }
    if (resourceId)   { params.push(resourceId);   where += ` AND resource_id = $${params.length}` }

    params.push(parseInt(limit), offset)
    const logs = await query(
      `SELECT id, actor_id, actor_type, actor_role, action,
              resource_type, resource_id, ip_address, surface, created_at,
              old_data, new_data, metadata
       FROM audit_logs
       ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    )

    const [{ count }] = await query<{ count: string }>(
      `SELECT COUNT(*) FROM audit_logs ${where}`, params.slice(0, -2)
    )

    return paginated(res, logs, parseInt(count), parseInt(page), parseInt(limit))
  }
)

// ─── ADMIN: Payroll list ──────────────────────────────────────────────────────

adminRouter.get(
  '/payroll',
  requirePermission('payroll.*'),
  async (req: Request, res: Response) => {
    const { page = '1', limit = '20', status, staffId } = req.query as Record<string, string>
    const offset = (parseInt(page) - 1) * parseInt(limit)

    const params: unknown[] = []
    let where = 'WHERE 1=1'
    if (status)  { params.push(status);  where += ` AND pr.status = $${params.length}` }
    if (staffId) { params.push(staffId); where += ` AND pr.staff_id = $${params.length}` }

    params.push(parseInt(limit), offset)
    const records = await query(
      `SELECT pr.id, pr.period_start, pr.period_end,
              pr.gross_salary, pr.deductions, pr.net_salary,
              pr.currency, pr.status, pr.paid_at, pr.created_at,
              s.first_name, s.last_name, s.employee_id, s.role
       FROM staff_payroll pr
       JOIN staff s ON s.id = pr.staff_id
       ${where}
       ORDER BY pr.period_start DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    )

    const [{ count }] = await query<{ count: string }>(
      `SELECT COUNT(*) FROM staff_payroll pr ${where}`, params.slice(0, -2)
    )

    return paginated(res, records, parseInt(count), parseInt(page), parseInt(limit))
  }
)

// ─── ADMIN: Create payroll entry ──────────────────────────────────────────────

adminRouter.post(
  '/payroll',
  requirePermission('payroll.*'),
  async (req: Request, res: Response) => {
    const schema = z.object({
      staffId:      z.string().uuid(),
      periodStart:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      periodEnd:    z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      grossSalary:  z.number().positive(),
      deductions:   z.number().min(0).default(0),
      currency:     z.string().default('UGX'),
      notes:        z.string().optional(),
    })
    const data = schema.parse(req.body)
    const netSalary = data.grossSalary - data.deductions

    const staff = await queryOne(`SELECT id FROM staff WHERE id = $1`, [data.staffId])
    if (!staff) throw new NotFoundError('Staff member')

    const record = await queryOne<{ id: string }>(
      `INSERT INTO staff_payroll
         (staff_id, period_start, period_end, gross_salary,
          deductions, net_salary, currency, notes, processed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [data.staffId, data.periodStart, data.periodEnd, data.grossSalary,
       data.deductions, netSalary, data.currency, data.notes ?? null, req.staffId]
    )

    await auditLog({
      actorId: req.staffId, actorType: 'staff', actorRole: req.staffRole,
      action: 'admin.payroll_created',
      resourceType: 'staff_payroll', resourceId: record!.id,
      newData: { staffId: data.staffId, net: netSalary, period: data.periodStart },
    })

    return success(res, { payrollId: record!.id, netSalary }, 201)
  }
)

// ─── ADMIN: Platform config ───────────────────────────────────────────────────

adminRouter.get(
  '/config',
  requirePermission('staff.read'),
  async (_req: Request, res: Response) => {
    return success(res, {
      platform: {
        name:               'Rheo Transport',
        currency:           'UGX',
        country:            'Uganda',
        timezone:           'Africa/Kampala',
        minWithdrawalUgx:   parseInt(process.env.MIN_WITHDRAWAL_UGX || '50000'),
        driverCommissionPct: parseFloat(process.env.DRIVER_COMMISSION_RATE || '0.01'),
        businessCommissionPct: 0.12,
      },
      subscriptionPlans: await query(`SELECT * FROM subscription_plans WHERE is_active = true`),
    })
  }
)
