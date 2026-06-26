import { Router, Request, Response } from 'express'
import { query, queryOne } from '../config/database'
import { authenticate, requirePermission } from '../middleware/rbac'
import { success } from '../utils/errors'

export const analyticsRouter = Router()

const requireBusiness = authenticate('business')
const requireStaff    = authenticate('staff')

// ─── BUSINESS: Dashboard summary (last 30 days) ───────────────────────────────

analyticsRouter.get('/business/summary', requireBusiness, async (req: Request, res: Response) => {
  // Use pre-aggregated daily snapshots for speed — avoid full table scans
  const summary = await queryOne<Record<string, unknown>>(
    `SELECT
       COALESCE(SUM(jobs_total), 0)          as jobs_total,
       COALESCE(SUM(jobs_delivered), 0)      as jobs_delivered,
       COALESCE(SUM(jobs_failed), 0)         as jobs_failed,
       COALESCE(SUM(jobs_cancelled), 0)      as jobs_cancelled,
       COALESCE(SUM(total_spend_ugx), 0)     as total_spend_ugx,
       COALESCE(AVG(avg_delivery_mins), 0)   as avg_delivery_mins,
       COALESCE(SUM(unique_drivers), 0)      as unique_drivers
     FROM business_analytics_daily
     WHERE business_id = $1
       AND date >= CURRENT_DATE - INTERVAL '30 days'`,
    [req.businessId]
  )

  // Delivery success rate
  const total     = parseInt(String(summary?.jobs_total || 0))
  const delivered = parseInt(String(summary?.jobs_delivered || 0))
  const successRate = total > 0 ? Math.round((delivered / total) * 100) : 0

  // Today's activity (real-time, not cached)
  const today = await queryOne<Record<string, unknown>>(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'queued')     as queued,
       COUNT(*) FILTER (WHERE status = 'assigned')   as assigned,
       COUNT(*) FILTER (WHERE status = 'in_transit') as in_transit,
       COUNT(*) FILTER (WHERE status = 'delivered')  as delivered_today
     FROM jobs
     WHERE business_id = $1 AND DATE(created_at) = CURRENT_DATE`,
    [req.businessId]
  )

  // 7-day trend (daily totals for sparkline charts)
  const trend = await query(
    `SELECT date, jobs_total, jobs_delivered, total_spend_ugx
     FROM business_analytics_daily
     WHERE business_id = $1 AND date >= CURRENT_DATE - INTERVAL '7 days'
     ORDER BY date ASC`,
    [req.businessId]
  )

  return success(res, { summary: { ...summary, successRate }, today, trend })
})

// ─── BUSINESS: Live job queue ──────────────────────────────────────────────────

analyticsRouter.get('/business/live-queue', requireBusiness, async (req: Request, res: Response) => {
  const jobs = await query(
    `SELECT j.id, j.job_ref, j.status, j.pickup_address, j.delivery_address,
            j.total_fare_ugx, j.created_at, j.assigned_at, j.picked_up_at,
            d.first_name as driver_first_name,
            d.last_name  as driver_last_name,
            d.phone      as driver_phone,
            d.last_lat, d.last_lng
     FROM jobs j
     LEFT JOIN drivers d ON d.id = j.driver_id
     WHERE j.business_id = $1
       AND j.status NOT IN ('delivered','failed','cancelled','disputed')
     ORDER BY j.created_at DESC`,
    [req.businessId]
  )
  return success(res, jobs)
})

// ─── BUSINESS: Billing summary ────────────────────────────────────────────────

analyticsRouter.get('/business/billing', requireBusiness, async (req: Request, res: Response) => {
  const subscription = await queryOne<Record<string, unknown>>(
    `SELECT bs.status, bs.billing_cycle, bs.amount_ugx,
            bs.current_period_start, bs.current_period_end,
            bs.trial_ends_at, bs.cancelled_at,
            sp.display_name as plan_name,
            sp.max_jobs_per_month, sp.max_team_members
     FROM business_subscriptions bs
     JOIN subscription_plans sp ON sp.id = bs.plan_id
     WHERE bs.business_id = $1 AND bs.status = 'active'
     ORDER BY bs.created_at DESC LIMIT 1`,
    [req.businessId]
  )

  const invoices = await query(
    `SELECT id, invoice_number, amount_ugx, total_ugx,
            status, due_date, paid_at, created_at
     FROM subscription_invoices
     WHERE business_id = $1
     ORDER BY created_at DESC LIMIT 12`,
    [req.businessId]
  )

  // Jobs used this billing period
  const [{ used }] = await query<{ used: string }>(
    `SELECT COUNT(*) as used FROM jobs
     WHERE business_id = $1
       AND created_at >= date_trunc('month', NOW())`,
    [req.businessId]
  )

  return success(res, { subscription, invoices, jobsUsedThisMonth: parseInt(used) })
})

// ─── ADMIN: Platform summary ──────────────────────────────────────────────────

analyticsRouter.get(
  '/admin/summary',
  requireStaff,
  requirePermission('analytics.*'),
  async (req: Request, res: Response) => {
    // Today's platform snapshot (real-time)
    const today = await queryOne<Record<string, unknown>>(
      `SELECT
         (SELECT COUNT(*) FROM drivers    WHERE status = 'approved')             as total_drivers,
         (SELECT COUNT(*) FROM drivers    WHERE is_online = true)                as online_drivers,
         (SELECT COUNT(*) FROM businesses WHERE status = 'active')              as active_businesses,
         (SELECT COUNT(*) FROM jobs       WHERE DATE(created_at) = CURRENT_DATE) as jobs_today,
         (SELECT COUNT(*) FROM jobs       WHERE status = 'queued')              as jobs_queued,
         (SELECT COUNT(*) FROM jobs       WHERE status IN ('assigned','in_transit')) as jobs_active,
         (SELECT COALESCE(SUM(total_fare_ugx),0) FROM jobs
          WHERE status = 'delivered' AND DATE(delivered_at) = CURRENT_DATE)    as revenue_today_ugx,
         (SELECT COUNT(*) FROM withdrawal_requests WHERE status = 'pending')   as pending_withdrawals,
         (SELECT COUNT(*) FROM support_tickets    WHERE status = 'open')       as open_tickets,
         (SELECT COUNT(*) FROM drivers    WHERE kyc_status = 'pending')        as pending_kyc`
    )

    // 30-day platform trend
    const trend = await query(
      `SELECT date, jobs_total, jobs_delivered, gross_revenue_ugx,
              rheo_revenue_ugx, active_drivers, active_businesses
       FROM platform_analytics_daily
       WHERE date >= CURRENT_DATE - INTERVAL '30 days'
       ORDER BY date ASC`,
      []
    )

    // Month-over-month comparison
    const mom = await queryOne<Record<string, unknown>>(
      `SELECT
         SUM(CASE WHEN date >= date_trunc('month', NOW()) THEN gross_revenue_ugx ELSE 0 END) as this_month_ugx,
         SUM(CASE WHEN date >= date_trunc('month', NOW()) - INTERVAL '1 month'
                   AND date <  date_trunc('month', Now())
                   THEN gross_revenue_ugx ELSE 0 END)                                        as last_month_ugx,
         SUM(CASE WHEN date >= date_trunc('month', Now()) THEN jobs_total ELSE 0 END)        as this_month_jobs,
         SUM(CASE WHEN date >= date_trunc('month', Now()) - INTERVAL '1 month'
                   AND date <  date_trunc('month', Now())
                   THEN jobs_total ELSE 0 END)                                               as last_month_jobs
       FROM platform_analytics_daily
       WHERE date >= date_trunc('month', Now()) - INTERVAL '1 month'`,
    )

    return success(res, { today, trend, monthOverMonth: mom })
  }
)

// ─── ADMIN: Finance report ─────────────────────────────────────────────────────

analyticsRouter.get(
  '/admin/finance',
  requireStaff,
  requirePermission('analytics.finance'),
  async (req: Request, res: Response) => {
    const { from, to } = req.query as Record<string, string>
    const dateFrom = from || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
    const dateTo   = to   || new Date().toISOString().split('T')[0]

    const revenue = await queryOne<Record<string, unknown>>(
      `SELECT
         COALESCE(SUM(total_fare_ugx), 0)       as gross_revenue_ugx,
         COALESCE(SUM(rheo_commission_ugx), 0)  as rheo_revenue_ugx,
         COALESCE(SUM(driver_payout_ugx), 0)    as driver_payouts_ugx,
         COUNT(*)                                as total_jobs,
         COUNT(*) FILTER (WHERE status='delivered') as delivered_jobs
       FROM jobs
       WHERE DATE(created_at) BETWEEN $1 AND $2`,
      [dateFrom, dateTo]
    )

    const withdrawals = await queryOne<Record<string, unknown>>(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending')    as pending_count,
         COUNT(*) FILTER (WHERE status = 'completed')  as completed_count,
         COALESCE(SUM(amount_ugx) FILTER (WHERE status = 'pending'), 0)   as pending_ugx,
         COALESCE(SUM(amount_ugx) FILTER (WHERE status = 'completed'), 0) as paid_ugx
       FROM withdrawal_requests
       WHERE DATE(created_at) BETWEEN $1 AND $2`,
      [dateFrom, dateTo]
    )

    const subscriptions = await queryOne<Record<string, unknown>>(
      `SELECT
         COALESCE(SUM(amount_ugx), 0)                                   as total_ugx,
         COUNT(*) FILTER (WHERE status = 'paid')                        as paid_count,
         COUNT(*) FILTER (WHERE status IN ('pending','overdue'))        as unpaid_count
       FROM subscription_invoices
       WHERE DATE(created_at) BETWEEN $1 AND $2`,
      [dateFrom, dateTo]
    )

    const topBusinesses = await query(
      `SELECT b.business_name, b.plan,
              COUNT(j.id)                as job_count,
              COALESCE(SUM(j.total_fare_ugx), 0) as total_spend_ugx
       FROM businesses b
       LEFT JOIN jobs j ON j.business_id = b.id
         AND DATE(j.created_at) BETWEEN $1 AND $2
       GROUP BY b.id, b.business_name, b.plan
       ORDER BY total_spend_ugx DESC LIMIT 10`,
      [dateFrom, dateTo]
    )

    return success(res, {
      period: { from: dateFrom, to: dateTo },
      revenue, withdrawals, subscriptions, topBusinesses,
    })
  }
)
