import { Router, Request, Response } from 'express'
import { z } from 'zod'
import multer from 'multer'

import { query, queryOne, withTransaction } from '../config/database'
import { authenticate, requirePermission } from '../middleware/rbac'
import { AppError, NotFoundError, success, paginated } from '../utils/errors'
import { encrypt, decrypt } from '../utils/encryption'
import { auditLog } from '../utils/audit'
import { uploadFile } from '../services/storage.service'
import { sendNotification } from '../services/notification.service'
import { sendSMS, smsTemplates } from '../services/sms.service'
import { emails } from '../services/email.service'
import { initiateTransfer } from '../services/flutterwave.service'
import { logger } from '../utils/logger'

export const driverRouter = Router()

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 5 * 1024 * 1024 }, // 5MB
})

const requireDriver   = authenticate('driver')
const requireStaff    = authenticate('staff')

// ─── DRIVER: Own profile ──────────────────────────────────────────────────────

driverRouter.get('/me', requireDriver, async (req: Request, res: Response) => {
  const driver = await queryOne<Record<string, unknown>>(
    `SELECT d.id, d.first_name, d.last_name, d.phone, d.alt_phone,
            d.avatar_url, d.date_of_birth, d.gender,
            d.district, d.sub_county, d.village,
            d.vehicle_type, d.vehicle_make, d.vehicle_model,
            d.vehicle_year, d.vehicle_color, d.plate_number,
            d.vehicle_capacity_kg, d.status, d.kyc_status,
            d.total_jobs, d.rating, d.rating_count,
            d.is_online, d.last_seen_at,
            u.email, u.is_verified, u.two_fa_enabled,
            w.balance_ugx, w.pending_ugx, w.total_earned_ugx
     FROM drivers d
     JOIN auth_users u ON u.id = d.auth_user_id
     LEFT JOIN driver_wallets w ON w.driver_id = d.id
     WHERE d.id = $1`,
    [req.driverId]
  )
  if (!driver) throw new NotFoundError('Driver')
  return success(res, driver)
})

// ─── DRIVER: Queue profile change (requires staff approval) ──────────────────

driverRouter.patch('/me', requireDriver, async (req: Request, res: Response) => {
  const schema = z.object({
    firstName:   z.string().min(2).optional(),
    lastName:    z.string().min(2).optional(),
    altPhone:    z.string().optional(),
    district:    z.string().optional(),
    subCounty:   z.string().optional(),
    village:     z.string().optional(),
    vehicleMake:  z.string().optional(),
    vehicleModel: z.string().optional(),
    vehicleColor: z.string().optional(),
    plateNumber:  z.string().optional(),
  })
  const data = schema.parse(req.body)

  // Each changed field becomes a separate pending change request
  const fieldMap: Record<string, string> = {
    firstName: 'first_name', lastName: 'last_name',
    altPhone: 'alt_phone', district: 'district',
    subCounty: 'sub_county', village: 'village',
    vehicleMake: 'vehicle_make', vehicleModel: 'vehicle_model',
    vehicleColor: 'vehicle_color', plateNumber: 'plate_number',
  }

  const changes: Array<{ field: string; value: string }> = []
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined && fieldMap[key]) {
      changes.push({ field: fieldMap[key], value: String(value) })
    }
  }

  if (changes.length === 0) throw new AppError('No changes provided', 400)

  // Fetch current values for audit trail
  const current = await queryOne<Record<string, unknown>>(
    `SELECT first_name, last_name, alt_phone, district, sub_county,
            village, vehicle_make, vehicle_model, vehicle_color, plate_number
     FROM drivers WHERE id = $1`,
    [req.driverId]
  )

  await Promise.all(
    changes.map((c) =>
      query(
        `INSERT INTO driver_profile_changes (driver_id, field_name, old_value, new_value)
         VALUES ($1, $2, $3, $4)`,
        [req.driverId, c.field, current?.[c.field] ?? null, c.value]
      )
    )
  )

  await auditLog({
    actorId: req.driverId, actorType: 'driver',
    action: 'driver.profile_change_requested',
    resourceType: 'driver', resourceId: req.driverId,
    newData: data,
  })

  return success(res, { message: 'Profile change request submitted for review.' })
})

// ─── DRIVER: Upload KYC document ─────────────────────────────────────────────

driverRouter.post(
  '/me/documents',
  requireDriver,
  upload.single('file'),
  async (req: Request, res: Response) => {
    const schema = z.object({
      docType: z.enum([
        'national_id_front', 'national_id_back', 'drivers_license',
        'vehicle_log_book', 'insurance', 'passport_photo', 'other',
      ]),
    })
    const { docType } = schema.parse(req.body)

    if (!req.file) throw new AppError('No file uploaded', 400)

    const { key, url } = await uploadFile({
      buffer:       req.file.buffer,
      mimeType:     req.file.mimetype,
      folder:       'drivers/docs',
      entityId:     req.driverId!,
      originalName: req.file.originalname,
    })

    const doc = await queryOne<{ id: string }>(
      `INSERT INTO driver_documents (driver_id, doc_type, file_url, file_name)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [req.driverId, docType, key, req.file.originalname]
    )

    // Auto-update KYC status to pending when first doc submitted
    await query(
      `UPDATE drivers SET kyc_status = 'pending'
       WHERE id = $1 AND kyc_status = 'not_submitted'`,
      [req.driverId]
    )

    return success(res, { documentId: doc!.id, url }, 201)
  }
)

// ─── DRIVER: Wallet ───────────────────────────────────────────────────────────

driverRouter.get('/me/wallet', requireDriver, async (req: Request, res: Response) => {
  const wallet = await queryOne<Record<string, unknown>>(
    `SELECT balance_ugx, pending_ugx, total_earned_ugx, total_withdrawn_ugx, min_withdraw_ugx
     FROM driver_wallets WHERE driver_id = $1`,
    [req.driverId]
  )
  if (!wallet) throw new NotFoundError('Wallet')

  // Last 20 transactions
  const transactions = await query(
    `SELECT id, type, status, amount_ugx, description, reference, created_at
     FROM transactions
     WHERE driver_id = $1
     ORDER BY created_at DESC LIMIT 20`,
    [req.driverId]
  )

  // Active withdrawal requests
  const pendingWithdrawals = await query(
    `SELECT id, amount_ugx, status, created_at
     FROM withdrawal_requests
     WHERE driver_id = $1 AND status IN ('pending','approved','processing')
     ORDER BY created_at DESC`,
    [req.driverId]
  )

  return success(res, { wallet, transactions, pendingWithdrawals })
})

// ─── DRIVER: Add payment method ───────────────────────────────────────────────

driverRouter.post('/me/payment-methods', requireDriver, async (req: Request, res: Response) => {
  const schema = z.object({
    type:          z.enum(['mtn_momo', 'airtel_money']),
    accountNumber: z.string().min(9).max(15),
    accountName:   z.string().min(2),
    isDefault:     z.boolean().default(false),
  })
  const data = schema.parse(req.body)

  // Encrypt account number before storing
  const encryptedAccount = encrypt(data.accountNumber)

  if (data.isDefault) {
    await query(
      `UPDATE driver_payment_methods SET is_default = false WHERE driver_id = $1`,
      [req.driverId]
    )
  }

  const displayName = `${data.type === 'mtn_momo' ? 'MTN MoMo' : 'Airtel Money'} — ${data.accountNumber.slice(-4).padStart(data.accountNumber.length, '*')}`

  const pm = await queryOne<{ id: string }>(
    `INSERT INTO driver_payment_methods
       (driver_id, type, display_name, account_number, account_name, is_default)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [req.driverId, data.type, displayName, encryptedAccount, data.accountName, data.isDefault]
  )

  return success(res, { paymentMethodId: pm!.id }, 201)
})

// ─── DRIVER: Request withdrawal ───────────────────────────────────────────────

driverRouter.post('/me/withdrawals', requireDriver, async (req: Request, res: Response) => {
  const schema = z.object({
    amountUgx:       z.number().positive(),
    paymentMethodId: z.string().uuid(),
  })
  const { amountUgx, paymentMethodId } = schema.parse(req.body)

  const wallet = await queryOne<{
    id: string; balance_ugx: number; min_withdraw_ugx: number
  }>(
    `SELECT id, balance_ugx, min_withdraw_ugx FROM driver_wallets WHERE driver_id = $1`,
    [req.driverId]
  )
  if (!wallet) throw new NotFoundError('Wallet')

  if (amountUgx < wallet.min_withdraw_ugx) {
    throw new AppError(
      `Minimum withdrawal is UGX ${wallet.min_withdraw_ugx.toLocaleString()}`,
      400, 'BELOW_MINIMUM'
    )
  }
  if (amountUgx > wallet.balance_ugx) {
    throw new AppError('Insufficient wallet balance', 400, 'INSUFFICIENT_BALANCE')
  }

  const pm = await queryOne<{ id: string }>(
    `SELECT id FROM driver_payment_methods WHERE id = $1 AND driver_id = $2`,
    [paymentMethodId, req.driverId]
  )
  if (!pm) throw new NotFoundError('Payment method')

  // Lock balance atomically — deduct immediately, restore if withdrawal fails
  const withdrawal = await withTransaction(async (client) => {
    // Row-level lock on wallet
    await client.query(
      `SELECT id FROM driver_wallets WHERE driver_id = $1 FOR UPDATE`,
      [req.driverId]
    )
    // Re-check balance inside lock
    const locked = await client.query(
      `SELECT balance_ugx FROM driver_wallets WHERE driver_id = $1`,
      [req.driverId]
    )
    if (parseFloat(locked.rows[0].balance_ugx) < amountUgx) {
      throw new AppError('Insufficient balance', 400, 'INSUFFICIENT_BALANCE')
    }
    // Deduct from balance, move to pending
    await client.query(
      `UPDATE driver_wallets
       SET balance_ugx = balance_ugx - $1, pending_ugx = pending_ugx + $1
       WHERE driver_id = $2`,
      [amountUgx, req.driverId]
    )
    const wrResult = await client.query(
      `INSERT INTO withdrawal_requests
         (driver_id, wallet_id, payment_method_id, amount_ugx, net_ugx)
       VALUES ($1,$2,$3,$4,$4) RETURNING id`,
      [req.driverId, wallet.id, paymentMethodId, amountUgx]
    )
    return wrResult.rows[0] as { id: string }
  })

  await auditLog({
    actorId: req.driverId, actorType: 'driver',
    action: 'driver.withdrawal_requested',
    resourceType: 'withdrawal_request', resourceId: withdrawal.id,
    newData: { amountUgx },
  })

  return success(res, { withdrawalId: withdrawal.id, status: 'pending' }, 201)
})

// ─── DRIVER: Self-deactivate ──────────────────────────────────────────────────

driverRouter.post('/me/deactivate', requireDriver, async (req: Request, res: Response) => {
  const { reason } = z.object({ reason: z.string().optional() }).parse(req.body)

  await query(
    `UPDATE drivers SET status = 'deactivated' WHERE id = $1`,
    [req.driverId]
  )
  await query(
    `UPDATE auth_users SET is_active = false WHERE id = $1`,
    [req.auth!.sub]
  )

  await auditLog({
    actorId: req.driverId, actorType: 'driver',
    action: 'driver.self_deactivated',
    resourceType: 'driver', resourceId: req.driverId,
    metadata: { reason },
  })

  return success(res, { message: 'Account deactivated.' })
})

// ─── STAFF: List drivers ──────────────────────────────────────────────────────

driverRouter.get(
  '/',
  requireStaff,
  requirePermission('drivers.read'),
  async (req: Request, res: Response) => {
    const { page = '1', limit = '20', status, vehicleType, search } = req.query as Record<string, string>
    const offset = (parseInt(page) - 1) * parseInt(limit)

    const params: unknown[] = []
    let where = 'WHERE 1=1'

    if (status)      { params.push(status);      where += ` AND d.status = $${params.length}` }
    if (vehicleType) { params.push(vehicleType); where += ` AND d.vehicle_type = $${params.length}` }
    if (search) {
      params.push(`%${search}%`)
      where += ` AND (d.first_name ILIKE $${params.length} OR d.last_name ILIKE $${params.length} OR d.phone ILIKE $${params.length})`
    }

    params.push(parseInt(limit), offset)
    const drivers = await query(
      `SELECT d.id, d.first_name, d.last_name, d.phone, d.status,
              d.vehicle_type, d.plate_number, d.kyc_status,
              d.total_jobs, d.rating, d.is_online, d.created_at,
              u.email
       FROM drivers d
       JOIN auth_users u ON u.id = d.auth_user_id
       ${where}
       ORDER BY d.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    )

    const [{ count }] = await query<{ count: string }>(
      `SELECT COUNT(*) FROM drivers d ${where}`,
      params.slice(0, -2)
    )

    return paginated(res, drivers, parseInt(count), parseInt(page), parseInt(limit))
  }
)

// ─── STAFF: Driver detail ─────────────────────────────────────────────────────

driverRouter.get(
  '/:id',
  requireStaff,
  requirePermission('drivers.read'),
  async (req: Request, res: Response) => {
    const driver = await queryOne<Record<string, unknown>>(
      `SELECT d.*, u.email, u.is_verified, u.last_login_at,
              w.balance_ugx, w.total_earned_ugx
       FROM drivers d
       JOIN auth_users u ON u.id = d.auth_user_id
       LEFT JOIN driver_wallets w ON w.driver_id = d.id
       WHERE d.id = $1`,
      [req.params.id]
    )
    if (!driver) throw new NotFoundError('Driver')

    const documents = await query(
      `SELECT id, doc_type, file_name, verified, verified_at, expires_at, created_at
       FROM driver_documents WHERE driver_id = $1 ORDER BY created_at DESC`,
      [req.params.id]
    )

    const profileChanges = await query(
      `SELECT id, field_name, old_value, new_value, status, created_at
       FROM driver_profile_changes WHERE driver_id = $1
       ORDER BY created_at DESC LIMIT 10`,
      [req.params.id]
    )

    return success(res, { driver, documents, profileChanges })
  }
)

// ─── STAFF: Approve / reject driver ──────────────────────────────────────────

driverRouter.post(
  '/:id/approve',
  requireStaff,
  requirePermission('drivers.approve'),
  async (req: Request, res: Response) => {
    const { action, reason } = z.object({
      action: z.enum(['approve', 'reject']),
      reason: z.string().optional(),
    }).parse(req.body)

    const driver = await queryOne<{ id: string; first_name: string; phone: string; auth_user_id: string }>(
      `SELECT id, first_name, phone, auth_user_id FROM drivers WHERE id = $1`,
      [req.params.id]
    )
    if (!driver) throw new NotFoundError('Driver')

    const newStatus = action === 'approve' ? 'approved' : 'rejected'

    await query(
      `UPDATE drivers
       SET status = $1, approved_by = $2, approved_at = NOW(),
           rejection_reason = $3
       WHERE id = $4`,
      [newStatus, req.staffId, reason ?? null, req.params.id]
    )

    if (action === 'approve') {
      await sendSMS({ to: driver.phone, message: smsTemplates.driverApproved(driver.first_name) })
    } else {
      await sendSMS({
        to:      driver.phone,
        message: `Hi ${driver.first_name}, your Rheo application was not approved. Reason: ${reason || 'Does not meet requirements'}. Contact support@rheo.co`,
      })
    }

    await auditLog({
      actorId: req.staffId, actorType: 'staff', actorRole: req.staffRole,
      action:  `driver.${action}`,
      resourceType: 'driver', resourceId: req.params.id,
      newData: { status: newStatus, reason },
    })

    return success(res, { status: newStatus })
  }
)

// ─── STAFF: Suspend driver ────────────────────────────────────────────────────

driverRouter.post(
  '/:id/suspend',
  requireStaff,
  requirePermission('drivers.approve'),
  async (req: Request, res: Response) => {
    const { reason } = z.object({ reason: z.string().min(5) }).parse(req.body)

    await query(
      `UPDATE drivers
       SET status = 'suspended', suspension_reason = $1, suspended_by = $2
       WHERE id = $3`,
      [reason, req.staffId, req.params.id]
    )

    await auditLog({
      actorId: req.staffId, actorType: 'staff', actorRole: req.staffRole,
      action: 'driver.suspend',
      resourceType: 'driver', resourceId: req.params.id,
      newData: { reason },
    })

    return success(res, { message: 'Driver suspended.' })
  }
)

// ─── STAFF: Review profile change ─────────────────────────────────────────────

driverRouter.post(
  '/profile-changes/:id/review',
  requireStaff,
  requirePermission('drivers.approve'),
  async (req: Request, res: Response) => {
    const { action, notes } = z.object({
      action: z.enum(['approve', 'reject']),
      notes:  z.string().optional(),
    }).parse(req.body)

    const change = await queryOne<{
      id: string; driver_id: string; field_name: string; new_value: string; status: string
    }>(
      `SELECT * FROM driver_profile_changes WHERE id = $1`,
      [req.params.id]
    )
    if (!change) throw new NotFoundError('Profile change request')
    if (change.status !== 'pending') throw new AppError('Change request already reviewed', 409)

    await query(
      `UPDATE driver_profile_changes
       SET status = $1, reviewed_by = $2, reviewed_at = NOW(), review_notes = $3
       WHERE id = $4`,
      [action === 'approve' ? 'approved' : 'rejected', req.staffId, notes ?? null, req.params.id]
    )

    // Apply change directly to drivers table if approved
    if (action === 'approve') {
      const safeFields = new Set([
        'first_name', 'last_name', 'alt_phone', 'district',
        'sub_county', 'village', 'vehicle_make', 'vehicle_model',
        'vehicle_color', 'plate_number',
      ])
      if (safeFields.has(change.field_name)) {
        await query(
          `UPDATE drivers SET ${change.field_name} = $1 WHERE id = $2`,
          [change.new_value, change.driver_id]
        )
      }
    }

    await auditLog({
      actorId: req.staffId, actorType: 'staff',
      action: `driver.profile_change.${action}`,
      resourceType: 'driver', resourceId: change.driver_id,
      newData: { field: change.field_name, value: change.new_value, action, notes },
    })

    return success(res, { status: action === 'approve' ? 'approved' : 'rejected' })
  }
)

// ─── STAFF: Process withdrawal ────────────────────────────────────────────────

driverRouter.post(
  '/withdrawals/:id/process',
  requireStaff,
  requirePermission('transactions.*'),
  async (req: Request, res: Response) => {
    const wr = await queryOne<{
      id: string; driver_id: string; wallet_id: string
      payment_method_id: string; amount_ugx: number
      net_ugx: number; status: string
    }>(
      `SELECT * FROM withdrawal_requests WHERE id = $1`,
      [req.params.id]
    )
    if (!wr) throw new NotFoundError('Withdrawal request')
    if (wr.status !== 'pending') throw new AppError('Withdrawal already processed', 409)

    const pm = await queryOne<{
      type: string; account_number: string; account_name: string
    }>(
      `SELECT type, account_number, account_name FROM driver_payment_methods WHERE id = $1`,
      [wr.payment_method_id]
    )
    if (!pm) throw new NotFoundError('Payment method')

    const accountNumber = decrypt(pm.account_number)
    const network       = pm.type === 'mtn_momo' ? 'MTN' : 'AIRTEL'
    const reference     = `WD-${Date.now()}`

    // Mark as processing before hitting Flutterwave
    await query(
      `UPDATE withdrawal_requests SET status = 'processing', approved_by = $1, approved_at = NOW()
       WHERE id = $2`,
      [req.staffId, wr.id]
    )

    try {
      const transfer = await initiateTransfer({
        amount:        wr.net_ugx,
        currency:      'UGX',
        accountNumber,
        accountName:   pm.account_name,
        network,
        narration:     `Rheo driver payout`,
        reference,
      })

      // Create transaction ledger entry
      await query(
        `INSERT INTO transactions
           (type, status, driver_id, amount_ugx, net_ugx, provider, provider_ref,
            description, reference, initiated_by, initiated_by_type)
         VALUES ('withdrawal','processing',$1,$2,$3,'flutterwave',$4,
                 'Driver withdrawal',$5,$6,'staff')`,
        [wr.driver_id, wr.amount_ugx, wr.net_ugx, String(transfer.id), reference, req.staffId]
      )

      await query(
        `UPDATE driver_wallets
         SET pending_ugx = pending_ugx - $1, total_withdrawn_ugx = total_withdrawn_ugx + $1
         WHERE driver_id = $2`,
        [wr.amount_ugx, wr.driver_id]
      )

      await auditLog({
        actorId: req.staffId, actorType: 'staff',
        action: 'driver.withdrawal_processed',
        resourceType: 'withdrawal_request', resourceId: wr.id,
        newData: { transferId: transfer.id, reference, amount: wr.net_ugx },
      })

      return success(res, { status: 'processing', transferId: transfer.id, reference })
    } catch (err: any) {
      // Restore withdrawal to pending if transfer initiation fails
      await query(
        `UPDATE withdrawal_requests SET status = 'pending', approved_by = NULL, approved_at = NULL
         WHERE id = $1`,
        [wr.id]
      )
      logger.error('Withdrawal transfer failed', { withdrawalId: wr.id, error: err.message })
      throw err
    }
  }
)
