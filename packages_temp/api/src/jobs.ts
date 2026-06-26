import cron from 'node-cron'
import { query, queryOne } from '../config/database'
import { logger } from '../utils/logger'
import { sendNotification } from '../modules/notifications/notification.service'
import { sendEmail } from '../modules/notifications/email.service'

export function startCronJobs() {
  logger.info('Starting cron jobs...')

  // ─── 1. Daily analytics aggregation — runs at 00:05 every day ──────────────
  cron.schedule('5 0 * * *', async () => {
    logger.info('Cron: Running daily analytics aggregation')
    try {
      const yesterday = new Date()
      yesterday.setDate(yesterday.getDate() - 1)
      const date = yesterday.toISOString().split('T')[0]

      // Platform-wide daily snapshot
      await query(
        `INSERT INTO platform_analytics_daily
          (date, active_drivers, active_businesses, jobs_total, jobs_delivered,
           gross_revenue_ugx, rheo_revenue_ugx, driver_payouts_ugx,
           new_drivers, new_businesses)
         SELECT
           $1::date,
           (SELECT COUNT(*) FROM drivers WHERE status = 'approved'),
           (SELECT COUNT(*) FROM businesses WHERE status = 'active'),
           COUNT(*) FILTER (WHERE created_at::date = $1),
           COUNT(*) FILTER (WHERE status = 'delivered' AND delivered_at::date = $1),
           COALESCE(SUM(total_fare_ugx) FILTER (WHERE status = 'delivered' AND delivered_at::date = $1), 0),
           COALESCE(SUM(rheo_commission_ugx) FILTER (WHERE status = 'delivered' AND delivered_at::date = $1), 0),
           COALESCE(SUM(driver_payout_ugx) FILTER (WHERE status = 'delivered' AND delivered_at::date = $1), 0),
           (SELECT COUNT(*) FROM drivers WHERE created_at::date = $1),
           (SELECT COUNT(*) FROM businesses WHERE created_at::date = $1)
         FROM jobs
         ON CONFLICT (date) DO UPDATE SET
           jobs_total = EXCLUDED.jobs_total,
           jobs_delivered = EXCLUDED.jobs_delivered,
           gross_revenue_ugx = EXCLUDED.gross_revenue_ugx,
           rheo_revenue_ugx = EXCLUDED.rheo_revenue_ugx,
           driver_payouts_ugx = EXCLUDED.driver_payouts_ugx`,
        [date]
      )

      // Per-business daily snapshot
      const businesses = await query(`SELECT id FROM businesses WHERE status = 'active'`)
      for (const biz of businesses) {
        await query(
          `INSERT INTO business_analytics_daily
            (business_id, date, jobs_total, jobs_delivered, jobs_failed,
             jobs_cancelled, total_spend_ugx, avg_delivery_mins, unique_drivers)
           SELECT
             $1, $2::date,
             COUNT(*),
             COUNT(*) FILTER (WHERE status = 'delivered'),
             COUNT(*) FILTER (WHERE status = 'failed'),
             COUNT(*) FILTER (WHERE status = 'cancelled'),
             COALESCE(SUM(total_fare_ugx) FILTER (WHERE status = 'delivered'), 0),
             COALESCE(AVG(EXTRACT(EPOCH FROM (delivered_at - assigned_at))/60)
               FILTER (WHERE status = 'delivered'), 0),
             COUNT(DISTINCT driver_id) FILTER (WHERE status = 'delivered')
           FROM jobs
           WHERE business_id = $1 AND created_at::date = $2
           ON CONFLICT (business_id, date) DO UPDATE SET
             jobs_total = EXCLUDED.jobs_total,
             jobs_delivered = EXCLUDED.jobs_delivered,
             jobs_failed = EXCLUDED.jobs_failed,
             jobs_cancelled = EXCLUDED.jobs_cancelled,
             total_spend_ugx = EXCLUDED.total_spend_ugx,
             avg_delivery_mins = EXCLUDED.avg_delivery_mins,
             unique_drivers = EXCLUDED.unique_drivers`,
          [biz.id, date]
        )
      }

      logger.info('Cron: Daily analytics aggregation complete', { date })
    } catch (err: any) {
      logger.error('Cron: Daily analytics failed', { error: err.message })
    }
  }, { timezone: 'Africa/Kampala' })

  // ─── 2. Subscription renewal check — runs daily at 08:00 ───────────────────
  cron.schedule('0 8 * * *', async () => {
    logger.info('Cron: Checking subscription renewals')
    try {
      // Find subs expiring in 7 days
      const expiringSoon = await query(
        `SELECT bs.*, b.primary_email, b.business_name, b.id as biz_id,
                bm.id as owner_id, sp.display_name as plan_name
         FROM business_subscriptions bs
         JOIN businesses b ON b.id = bs.business_id
         JOIN business_members bm ON bm.business_id = b.id AND bm.role = 'owner'
         JOIN subscription_plans sp ON sp.id = bs.plan_id
         WHERE bs.status = 'active'
           AND bs.current_period_end::date = CURRENT_DATE + INTERVAL '7 days'`
      )

      for (const sub of expiringSoon) {
        await sendNotification({
          recipientId: sub.owner_id,
          recipientType: 'business_member',
          type: 'payment',
          title: 'Subscription Renewing in 7 Days',
          body: `Your ${sub.plan_name} plan renews on ${new Date(sub.current_period_end).toLocaleDateString()}. Ensure your payment method is up to date.`,
          sendPush: true,
          sendEmail: true,
        })
      }

      // Find expired subs and mark them
      const expired = await query(
        `UPDATE business_subscriptions
         SET status = 'expired'
         WHERE status = 'active' AND current_period_end < NOW()
         RETURNING business_id, id`
      )

      for (const sub of expired) {
        // Downgrade business to no active plan
        await query(
          `UPDATE businesses SET plan = 'starter' WHERE id = $1`,
          [sub.business_id]
        )

        const owner = await queryOne<any>(
          `SELECT id FROM business_members WHERE business_id = $1 AND role = 'owner'`,
          [sub.business_id]
        )
        if (owner) {
          await sendNotification({
            recipientId: owner.id,
            recipientType: 'business_member',
            type: 'payment',
            title: 'Subscription Expired',
            body: 'Your Rheo subscription has expired. Renew now to continue accessing all features.',
            sendPush: true,
            sendEmail: true,
          })
        }
      }

      logger.info('Cron: Subscription check complete', {
        expiringSoon: expiringSoon.length,
        expired: expired.length,
      })
    } catch (err: any) {
      logger.error('Cron: Subscription check failed', { error: err.message })
    }
  }, { timezone: 'Africa/Kampala' })

  // ─── 3. Stale job cleanup — runs every hour ─────────────────────────────────
  // Jobs that have been assigned but not picked up in 2 hours go back to queue
  cron.schedule('0 * * * *', async () => {
    try {
      const staleJobs = await query(
        `UPDATE jobs
         SET status = 'queued', driver_id = NULL, assigned_at = NULL
         WHERE status = 'assigned'
           AND assigned_at < NOW() - INTERVAL '2 hours'
         RETURNING id, job_ref, driver_id`
      )

      for (const job of staleJobs) {
        if (job.driver_id) {
          await sendNotification({
            recipientId: job.driver_id,
            recipientType: 'driver',
            type: 'job_update',
            title: 'Job Returned to Queue',
            body: `Job ${job.job_ref} was returned to the queue because it wasn't picked up in time.`,
            sendPush: true,
          })
        }
        logger.warn('Cron: Stale job returned to queue', { jobRef: job.job_ref })
      }
    } catch (err: any) {
      logger.error('Cron: Stale job cleanup failed', { error: err.message })
    }
  })

  // ─── 4. Driver online status cleanup — every 2 minutes ─────────────────────
  // Mark drivers offline if they haven't sent a heartbeat in 5 minutes
  cron.schedule('*/2 * * * *', async () => {
    try {
      await query(
        `UPDATE drivers SET is_online = false
         WHERE is_online = true AND last_seen_at < NOW() - INTERVAL '5 minutes'`
      )
    } catch (err: any) {
      logger.error('Cron: Driver online cleanup failed', { error: err.message })
    }
  })

  // ─── 5. Pending withdrawal auto-reminder — runs daily at 09:00 ─────────────
  cron.schedule('0 9 * * *', async () => {
    try {
      const [{ count }] = await query(
        `SELECT COUNT(*) FROM withdrawal_requests WHERE status = 'pending'`
      )
      if (parseInt(count) > 0) {
        logger.warn(`Cron: ${count} pending withdrawals need processing`)
        // Could send Slack/email to finance team here
      }
    } catch (err: any) {
      logger.error('Cron: Withdrawal reminder failed', { error: err.message })
    }
  }, { timezone: 'Africa/Kampala' })

  logger.info('All cron jobs scheduled')
}
