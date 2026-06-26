import { Router, Request, Response } from 'express'
import { z } from 'zod'
import multer from 'multer'

import { query, queryOne, withTransaction } from '../../config/database'
import { requireDriver, requireBusiness, requireStaff, requirePermission } from '../../middleware/rbac'
import { AppError, NotFoundError, success, paginated } from '../../utils/errors'
import { auditLog } from '../../utils/audit'
import { redis } from '../../config/redis'
import { uploadFile } from '../storage/storage.service'
import { sendNotification } from '../notifications/notification.service'
import { getIO } from '../../config/socket'

export const jobRouter = Router()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } })

const DRIVER_COMMISSION = parseFloat(process.env.DRIVER_COMMISSION_RATE || '0.01')

// ─── BUSINESS: Create job ────────────────────────────────────────────────────

jobRouter.post(
  '/',
  requireBusiness,
  requirePermission('jobs.create'),
  async (req: Request, res: Response) => {
    const schema = z.object({
      description: z.string().min(5),
      weightKg: z.number().positive().optional(),
      fragile: z.boolean().default(false),
      specialInstructions: z.string().optional(),

      pickupAddress: z.string().min(5),
      pickupLat: z.number().optional(),
      pickupLng: z.number().optional(),
      pickupContactName: z.string().optional(),
      pickupContactPhone: z.string().optional(),

      deliveryAddress: z.string().min(5),
      deliveryLat: z.number().optional(),
      deliveryLng: z.number().optional(),
      deliveryContactName: z.string().optional(),
      deliveryContactPhone: z.string().optional(),
      deliveryNotes: z.string().optional(),

      scheduledFor: z.string().datetime().optional(),
      baseFareUgx: z.number().positive(),
    })

    const data = schema.parse(req.body)

    // Get business member
    const member = await queryOne<any>(
      `SELECT id FROM business_members WHERE auth_user_id = $1`,
      [req.auth!.sub]
    )
    if (!member) throw new AppError('Business member not found', 404)

    // Check subscription job limit
    const business = await queryOne<any>(
      `SELECT b.id, sp.max_jobs_per_month
       FROM businesses b
       LEFT JOIN business_subscriptions bs ON bs.business_id = b.id AND bs.status = 'active'
       LEFT JOIN subscription_plans sp ON sp.id = bs.plan_id
       WHERE b.id = $1`,
      [req.businessId]
    )
    if (business?.max_jobs_per_month) {
      const [{ count }] = await query(
        `SELECT COUNT(*) FROM jobs
         WHERE business_id = $1
         AND created_at >= date_trunc('month', NOW())`,
        [req.businessId]
      )
      if (parseInt(count) >= business.max_jobs_per_month) {
        throw new AppError(
          `Monthly job limit (${business.max_jobs_per_month}) reached. Upgrade your plan to continue.`,
          429
        )
      }
    }

    const surgeMultiplier = 1.0 // TODO: calculate surge based on demand
    const totalFare = data.baseFareUgx * surgeMultiplier
    const rheoCommission = totalFare * 0.12 // business-side commission
    const driverPayout = totalFare - rheoCommission

    const job = await queryOne<any>(
      `INSERT INTO jobs (
        business_id, created_by,
        description, weight_kg, fragile, special_instructions,
        pickup_address, pickup_lat, pickup_lng, pickup_contact_name, pickup_contact_phone,
        delivery_address, delivery_lat, delivery_lng, delivery_contact_name, delivery_contact_phone, delivery_notes,
        scheduled_for,
        base_fare_ugx, surge_multiplier, total_fare_ugx, driver_payout_ugx, rheo_commission_ugx
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11,
        $12, $13, $14, $15, $16, $17,
        $18, $19, $20, $21, $22, $23
      ) RETURNING *`,
      [
        req.businessId, member.id,
        data.description, data.weightKg, data.fragile, data.specialInstructions,
        data.pickupAddress, data.pickupLat, data.pickupLng, data.pickupContactName, data.pickupContactPhone,
        data.deliveryAddress, data.deliveryLat, data.deliveryLng, data.deliveryContactName, data.deliveryContactPhone, data.deliveryNotes,
        data.scheduledFor || null,
        data.baseFareUgx, surgeMultiplier, totalFare, driverPayout, rheoCommission,
      ]
    )

    // Broadcast new job to online drivers via WebSocket
    const io = getIO()
    io.to('drivers:online').emit('job:new', {
      id: job!.id,
      ref: job!.job_ref,
      pickup: job!.pickup_address,
      delivery: job!.delivery_address,
      fare: job!.total_fare_ugx,
    })

    await auditLog({
      actorId: req.auth!.sub,
      actorType: 'business_member',
      action: 'job.created',
      resourceType: 'job',
      resourceId: job!.id,
      newData: { ref: job!.job_ref, fare: totalFare },
      ip: req.ip,
      surface: 'business',
    })

    return success(res, job, 201)
  }
)

// ─── BUSINESS: List own jobs ──────────────────────────────────────────────────

jobRouter.get(
  '/business',
  requireBusiness,
  requirePermission('jobs.read'),
  async (req: Request, res: Response) => {
    const { page = '1', limit = '20', status, search, from, to } = req.query as Record<string, string>
    const offset = (parseInt(page) - 1) * parseInt(limit)

    let where = 'WHERE j.business_id = $1'
    const params: any[] = [req.businessId]

    if (status) { params.push(status); where += ` AND j.status = $${params.length}` }
    if (from)   { params.push(from);   where += ` AND j.created_at >= $${params.length}` }
    if (to)     { params.push(to);     where += ` AND j.created_at <= $${params.length}` }
    if (search) {
      params.push(`%${search}%`)
      where += ` AND (j.job_ref ILIKE $${params.length} OR j.delivery_address ILIKE $${params.length})`
    }

    params.push(parseInt(limit), offset)
    const jobs = await query(
      `SELECT j.*, d.first_name as driver_first, d.last_name as driver_last, d.phone as driver_phone
       FROM jobs j
       LEFT JOIN drivers d ON d.id = j.driver_id
       ${where}
       ORDER BY j.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    )

    const [{ count }] = await query(`SELECT COUNT(*) FROM jobs j ${where}`, params.slice(0, -2))
    return paginated(res, jobs, parseInt(count), parseInt(page), parseInt(limit))
  }
)

// ─── DRIVER: Get job board (available jobs) ───────────────────────────────────

jobRouter.get('/board', requireDriver, async (req: Request, res: Response) => {
  const { lat, lng } = req.query as Record<string, string>

  // Verify driver is approved
  const driver = await queryOne<any>(
    `SELECT status FROM drivers WHERE id = $1`,
    [req.driverId]
  )
  if (driver?.status !== 'approved') {
    throw new AppError('Your account must be approved to view jobs', 403)
  }

  let orderBy = 'j.created_at DESC'
  const params: any[] = []

  // If driver has location, sort by proximity
  if (lat && lng) {
    params.push(parseFloat(lng), parseFloat(lat))
    orderBy = `ST_Distance(
      ST_MakePoint(j.pickup_lng, j.pickup_lat)::geography,
      ST_MakePoint($1, $2)::geography
    )`
  }

  params.push(20) // limit
  const jobs = await query(
    `SELECT j.id, j.job_ref, j.pickup_address, j.pickup_lat, j.pickup_lng,
            j.delivery_address, j.total_fare_ugx, j.driver_payout_ugx,
            j.weight_kg, j.fragile, j.description, j.scheduled_for, j.created_at
     FROM jobs j
     WHERE j.status = 'queued'
     AND j.driver_id IS NULL
     ORDER BY ${orderBy}
     LIMIT $${params.length}`,
    params
  )

  return success(res, jobs)
})

// ─── DRIVER: Accept job ───────────────────────────────────────────────────────

jobRouter.post('/board/:jobId/accept', requireDriver, async (req: Request, res: Response) => {
  const { jobId } = req.params

  // Distributed lock — prevent two drivers accepting simultaneously
  const locked = await redis.lockJob(jobId, req.driverId!, 10)
  if (!locked) throw new AppError('This job was just taken by another driver', 409)

  try {
    const job = await queryOne<any>(
      `SELECT * FROM jobs WHERE id = $1 AND status = 'queued' AND driver_id IS NULL`,
      [jobId]
    )
    if (!job) {
      await redis.unlockJob(jobId)
      throw new AppError('Job is no longer available', 404)
    }

    // Check driver has no active job
    const activeJob = await queryOne(
      `SELECT id FROM jobs WHERE driver_id = $1 AND status IN ('assigned','picked_up','in_transit')`,
      [req.driverId]
    )
    if (activeJob) {
      await redis.unlockJob(jobId)
      throw new AppError('You already have an active delivery. Complete it before accepting a new one.', 400)
    }

    await withTransaction(async (client) => {
      await client.query(
        `UPDATE jobs SET driver_id = $1, status = 'assigned', assigned_at = NOW() WHERE id = $2`,
        [req.driverId, jobId]
      )
      await client.query(
        `INSERT INTO job_status_history (job_id, old_status, new_status, changed_by, changed_by_type)
         VALUES ($1, 'queued', 'assigned', $2, 'driver')`,
        [jobId, req.driverId]
      )
    })

    // Notify business
    const member = await queryOne<any>(
      `SELECT bm.auth_user_id FROM jobs j JOIN business_members bm ON bm.id = j.created_by WHERE j.id = $1`,
      [jobId]
    )
    if (member) {
      await sendNotification({
        recipientId: member.auth_user_id,
        recipientType: 'business_member',
        type: 'job_assigned',
        title: 'Driver Assigned',
        body: `A driver has accepted job ${job.job_ref} and is heading to pickup.`,
        data: { jobId },
        sendPush: true,
      })
    }

    // Emit real-time update to business dashboard
    const io = getIO()
    io.to(`business:${job.business_id}`).emit('job:assigned', {
      jobId,
      driverId: req.driverId,
      ref: job.job_ref,
    })

    return success(res, { message: 'Job accepted', jobId, ref: job.job_ref })
  } finally {
    await redis.unlockJob(jobId)
  }
})

// ─── DRIVER: Update job status ────────────────────────────────────────────────

jobRouter.post('/:jobId/status', requireDriver, async (req: Request, res: Response) => {
  const { status, lat, lng, notes } = z.object({
    status: z.enum(['picked_up', 'in_transit', 'delivered', 'failed']),
    lat: z.number().optional(),
    lng: z.number().optional(),
    notes: z.string().optional(),
  }).parse(req.body)

  const job = await queryOne<any>(
    `SELECT * FROM jobs WHERE id = $1 AND driver_id = $2`,
    [req.params.jobId, req.driverId]
  )
  if (!job) throw new NotFoundError('Job')

  // Valid transitions
  const transitions: Record<string, string[]> = {
    assigned:   ['picked_up'],
    picked_up:  ['in_transit'],
    in_transit: ['delivered', 'failed'],
  }
  if (!transitions[job.status]?.includes(status)) {
    throw new AppError(`Cannot transition from ${job.status} to ${status}`, 400)
  }

  await withTransaction(async (client) => {
    const updates: string[] = [`status = '${status}'`, `updated_at = NOW()`]
    if (status === 'picked_up')  updates.push(`picked_up_at = NOW()`)
    if (status === 'delivered')  updates.push(`delivered_at = NOW()`)
    if (status === 'failed')     updates.push(`failed_at = NOW()`, `fail_reason = '${notes || ''}'`)

    await client.query(
      `UPDATE jobs SET ${updates.join(', ')} WHERE id = $1`,
      [job.id]
    )
    await client.query(
      `INSERT INTO job_status_history (job_id, old_status, new_status, changed_by, changed_by_type, notes, lat, lng)
       VALUES ($1, $2, $3, $4, 'driver', $5, $6, $7)`,
      [job.id, job.status, status, req.driverId, notes, lat, lng]
    )

    // Credit driver wallet on delivery
    if (status === 'delivered') {
      const driverNet = job.driver_payout_ugx * (1 - DRIVER_COMMISSION)
      const commission = job.driver_payout_ugx * DRIVER_COMMISSION

      await client.query(
        `UPDATE driver_wallets
         SET balance_ugx = balance_ugx + $1,
             total_earned_ugx = total_earned_ugx + $2
         WHERE driver_id = $3`,
        [driverNet, job.driver_payout_ugx, req.driverId]
      )
      await client.query(
        `UPDATE drivers SET total_jobs = total_jobs + 1, total_earnings_ugx = total_earnings_ugx + $1 WHERE id = $2`,
        [driverNet, req.driverId]
      )

      const txRef = `TXN-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`
      await client.query(
        `INSERT INTO transactions (type, status, driver_id, business_id, job_id, amount_ugx, fee_ugx, net_ugx, description, reference, initiated_by_type)
         VALUES ('job_earning', 'completed', $1, $2, $3, $4, $5, $6, $7, $8, 'system')`,
        [req.driverId, job.business_id, job.id, job.driver_payout_ugx, commission, driverNet,
         `Earnings for job ${job.job_ref}`, txRef]
      )
    }
  })

  // Real-time update to all subscribers (business + any trackers)
  const io = getIO()
  io.to(`job:${job.id}`).emit('job:status', { jobId: job.id, status, lat, lng })
  io.to(`business:${job.business_id}`).emit('job:status', { jobId: job.id, ref: job.job_ref, status })

  if (status === 'delivered') {
    await sendNotification({
      recipientId: job.created_by,
      recipientType: 'business_member',
      type: 'job_update',
      title: 'Delivery Complete ✅',
      body: `Job ${job.job_ref} has been delivered successfully.`,
      data: { jobId: job.id },
      sendPush: true,
    })
  }

  return success(res, { message: `Job status updated to ${status}` })
})

// ─── DRIVER: Submit proof of delivery ────────────────────────────────────────

jobRouter.post(
  '/:jobId/pod',
  requireDriver,
  upload.single('photo'),
  async (req: Request, res: Response) => {
    const { notes } = req.body

    const job = await queryOne<any>(
      `SELECT * FROM jobs WHERE id = $1 AND driver_id = $2 AND status = 'delivered'`,
      [req.params.jobId, req.driverId]
    )
    if (!job) throw new NotFoundError('Delivered job')

    let photoUrl: string | null = null
    if (req.file) {
      photoUrl = await uploadFile({
        buffer: req.file.buffer,
        mimeType: req.file.mimetype,
        folder: `jobs/${req.params.jobId}/pod`,
        filename: `photo-${Date.now()}`,
      })
    }

    await query(
      `UPDATE jobs SET pod_photo_url = $1, pod_notes = $2 WHERE id = $3`,
      [photoUrl, notes, req.params.jobId]
    )

    return success(res, { message: 'Proof of delivery submitted', photoUrl })
  }
)

// ─── DRIVER: Get own active job ───────────────────────────────────────────────

jobRouter.get('/me/active', requireDriver, async (req: Request, res: Response) => {
  const job = await queryOne<any>(
    `SELECT j.*, b.business_name
     FROM jobs j
     JOIN businesses b ON b.id = j.business_id
     WHERE j.driver_id = $1 AND j.status IN ('assigned', 'picked_up', 'in_transit')`,
    [req.driverId]
  )
  return success(res, job)
})

// ─── DRIVER: Get job history ──────────────────────────────────────────────────

jobRouter.get('/me/history', requireDriver, async (req: Request, res: Response) => {
  const { page = '1', limit = '20' } = req.query as Record<string, string>
  const offset = (parseInt(page) - 1) * parseInt(limit)

  const jobs = await query(
    `SELECT j.id, j.job_ref, j.status, j.pickup_address, j.delivery_address,
            j.total_fare_ugx, j.driver_payout_ugx, j.delivered_at, j.created_at
     FROM jobs j
     WHERE j.driver_id = $1 AND j.status IN ('delivered','failed','cancelled')
     ORDER BY j.created_at DESC LIMIT $2 OFFSET $3`,
    [req.driverId, parseInt(limit), offset]
  )
  const [{ count }] = await query(
    `SELECT COUNT(*) FROM jobs WHERE driver_id = $1 AND status IN ('delivered','failed','cancelled')`,
    [req.driverId]
  )

  return paginated(res, jobs, parseInt(count), parseInt(page), parseInt(limit))
})

// ─── LIVE TRACKING: Update driver location ────────────────────────────────────

jobRouter.post('/tracking/location', requireDriver, async (req: Request, res: Response) => {
  const { lat, lng, speed, heading, accuracy, jobId } = z.object({
    lat: z.number(),
    lng: z.number(),
    speed: z.number().optional(),
    heading: z.number().optional(),
    accuracy: z.number().optional(),
    jobId: z.string().uuid().optional(),
  }).parse(req.body)

  // Update driver's last known location
  await query(
    `UPDATE drivers SET last_lat = $1, last_lng = $2, last_seen_at = NOW(), is_online = true WHERE id = $3`,
    [lat, lng, req.driverId]
  )
  await redis.setDriverOnline(req.driverId!, { lat, lng, speed }, 30)

  // If on an active job, record tracking point
  if (jobId) {
    await query(
      `INSERT INTO job_tracking (job_id, driver_id, lat, lng, speed_kmh, heading, accuracy_m)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [jobId, req.driverId, lat, lng, speed, heading, accuracy]
    )

    // Broadcast to job room (business tracking map)
    const io = getIO()
    io.to(`job:${jobId}`).emit('driver:location', { driverId: req.driverId, lat, lng, speed })
  }

  return res.status(204).send()
})

// ─── STAFF: List all jobs ─────────────────────────────────────────────────────

jobRouter.get(
  '/',
  requireStaff,
  requirePermission('jobs.read'),
  async (req: Request, res: Response) => {
    const { page = '1', limit = '20', status, businessId, driverId } = req.query as Record<string, string>
    const offset = (parseInt(page) - 1) * parseInt(limit)

    let where = 'WHERE 1=1'
    const params: any[] = []

    if (status)     { params.push(status);     where += ` AND j.status = $${params.length}` }
    if (businessId) { params.push(businessId); where += ` AND j.business_id = $${params.length}` }
    if (driverId)   { params.push(driverId);   where += ` AND j.driver_id = $${params.length}` }

    params.push(parseInt(limit), offset)
    const jobs = await query(
      `SELECT j.*, b.business_name,
              d.first_name as driver_first, d.last_name as driver_last
       FROM jobs j
       JOIN businesses b ON b.id = j.business_id
       LEFT JOIN drivers d ON d.id = j.driver_id
       ${where}
       ORDER BY j.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    )

    const [{ count }] = await query(`SELECT COUNT(*) FROM jobs j ${where}`, params.slice(0, -2))
    return paginated(res, jobs, parseInt(count), parseInt(page), parseInt(limit))
  }
)

// ─── STAFF: Get single job detail ─────────────────────────────────────────────

jobRouter.get(
  '/:jobId',
  requireStaff,
  requirePermission('jobs.read'),
  async (req: Request, res: Response) => {
    const job = await queryOne<any>(
      `SELECT j.*, b.business_name,
              d.first_name as driver_first, d.last_name as driver_last, d.phone as driver_phone
       FROM jobs j
       JOIN businesses b ON b.id = j.business_id
       LEFT JOIN drivers d ON d.id = j.driver_id
       WHERE j.id = $1`,
      [req.params.jobId]
    )
    if (!job) throw new NotFoundError('Job')

    const statusHistory = await query(
      `SELECT * FROM job_status_history WHERE job_id = $1 ORDER BY created_at ASC`,
      [req.params.jobId]
    )

    const tracking = await query(
      `SELECT lat, lng, speed_kmh, recorded_at FROM job_tracking WHERE job_id = $1 ORDER BY recorded_at ASC`,
      [req.params.jobId]
    )

    return success(res, { job, statusHistory, tracking })
  }
)

// ─── BUSINESS: Cancel job ─────────────────────────────────────────────────────

jobRouter.post(
  '/:jobId/cancel',
  requireBusiness,
  requirePermission('jobs.update'),
  async (req: Request, res: Response) => {
    const { reason } = z.object({ reason: z.string().min(5) }).parse(req.body)

    const job = await queryOne<any>(
      `SELECT * FROM jobs WHERE id = $1 AND business_id = $2`,
      [req.params.jobId, req.businessId]
    )
    if (!job) throw new NotFoundError('Job')
    if (!['queued', 'assigned'].includes(job.status)) {
      throw new AppError('Job cannot be cancelled once pickup has started', 400)
    }

    await withTransaction(async (client) => {
      await client.query(
        `UPDATE jobs SET status = 'cancelled', cancellation_reason = $1, cancelled_by = $2 WHERE id = $3`,
        [reason, req.auth!.sub, job.id]
      )
      await client.query(
        `INSERT INTO job_status_history (job_id, old_status, new_status, changed_by, changed_by_type, notes)
         VALUES ($1, $2, 'cancelled', $3, 'business_member', $4)`,
        [job.id, job.status, req.auth!.sub, reason]
      )
    })

    // Notify driver if assigned
    if (job.driver_id) {
      await sendNotification({
        recipientId: job.driver_id,
        recipientType: 'driver',
        type: 'job_update',
        title: 'Job Cancelled',
        body: `Job ${job.job_ref} has been cancelled by the business.`,
        sendPush: true,
      })
      const io = getIO()
      io.to(`driver:${job.driver_id}`).emit('job:cancelled', { jobId: job.id })
    }

    return success(res, { message: 'Job cancelled' })
  }
)
