import { Router, Request, Response } from 'express'
import { z } from 'zod'
import express from 'express'

import { query, queryOne, withTransaction } from '../config/database'
import { requireBusiness, requireStaff, requirePermission } from '../middleware/rbac'
import { AppError, NotFoundError, success, paginated } from '../utils/errors'
import { auditLog } from '../utils/audit'
import { decrypt, generateToken } from '../utils/encryption'
import { logger } from '../utils/logger'
import { sendNotification } from '../services/notification.service'
import { sendEmail } from '../services/email.service'
import {
  chargeMobileMoney, initiateCardPayment, initiateTransfer,
  verifyTransaction, verifyWebhookSignature, getAccountBank,
} from '../services/flutterwave.service'

export const paymentRouter = Router()

// ─── BUSINESS: Initiate subscription payment ──────────────────────────────────

paymentRouter.post(
  '/subscriptions/checkout',
  requireBusiness,
  async (req: Request, res: Response) => {
    const { planName, billingCycle, paymentMethodId } = z.object({
      planName:        z.enum(['starter', 'growth', 'enterprise', 'custom']),
      billingCycle:    z.enum(['monthly', 'annual']),
      paymentMethodId: z.string().uuid().optional(),
    }).parse(req.body)

    const plan = await queryOne<any>(
      `SELECT * FROM subscription_plans WHERE name = $1 AND is_active = true`,
      [planName]
    )
    if (!plan) throw new NotFoundError('Subscription plan')

    const amount = billingCycle === 'annual'
      ? plan.annual_price_ugx
      : plan.monthly_price_ugx

    if (!amount) throw new AppError('This plan requires custom pricing. Contact sales.', 400)

    const business = await queryOne<any>(
      `SELECT b.*, u.email FROM businesses b JOIN auth_users u ON u.id = b.auth_user_id WHERE b.id = $1`,
      [req.businessId]
    )
    if (!business) throw new NotFoundError('Business')

    const txRef = `SUB-${Date.now()}-${generateToken(4).toUpperCase()}`

    // If they have a saved MoMo method, charge directly
    if (paymentMethodId) {
      const pm = await queryOne<any>(
        `SELECT * FROM business_payment_methods WHERE id = $1 AND business_id = $2`,
        [paymentMethodId, req.businessId]
      )
      if (!pm) throw new NotFoundError('Payment method')

      const accountNumber = decrypt(pm.account_number)
      const network = pm.type === 'mtn_momo' ? 'MTN' : 'AIRTEL'

      const charge = await chargeMobileMoney({
        amount,
        currency: 'UGX',
        phone: accountNumber,
        network,
        email: business.email,
        name: business.business_name,
        txRef,
        narration: `Rheo ${plan.display_name} ${billingCycle} subscription`,
      })

      // Store pending transaction
      await query(
        `INSERT INTO transactions
          (type, status, business_id, amount_ugx, fee_ugx, net_ugx, provider, provider_ref, description, reference, initiated_by_type)
         VALUES ('subscription_charge','pending',$1,$2,0,$2,'flutterwave',$3,$4,$5,'system')`,
        [req.businessId, amount, charge.data?.flw_ref, `${plan.display_name} subscription`, txRef]
      )

      return success(res, {
        message: 'Payment initiated. Check your phone to approve the MoMo request.',
        txRef,
        flwRef: charge.data?.flw_ref,
      })
    }

    // Otherwise redirect to hosted payment page (card / any method)
    const paymentLink = await initiateCardPayment({
      amount,
      currency: 'UGX',
      email: business.primary_email,
      name: business.business_name,
      phone: business.primary_phone,
      txRef,
      redirectUrl: `${process.env.WEB_URL}/billing/callback?ref=${txRef}`,
      meta: { businessId: req.businessId, planName, billingCycle },
    })

    await query(
      `INSERT INTO transactions
        (type, status, business_id, amount_ugx, fee_ugx, net_ugx, provider, description, reference, initiated_by_type)
       VALUES ('subscription_charge','pending',$1,$2,0,$2,'flutterwave',$3,$4,'system')`,
      [req.businessId, amount, `${plan.display_name} subscription`, txRef]
    )

    return success(res, { paymentLink: paymentLink.data?.link, txRef })
  }
)

// ─── BUSINESS: Cancel subscription ───────────────────────────────────────────

paymentRouter.post(
  '/subscriptions/cancel',
  requireBusiness,
  async (req: Request, res: Response) => {
    const { reason } = z.object({ reason: z.string().optional() }).parse(req.body)

    const sub = await queryOne<any>(
      `SELECT * FROM business_subscriptions WHERE business_id = $1 AND status = 'active'`,
      [req.businessId]
    )
    if (!sub) throw new NotFoundError('Active subscription')

    await query(
      `UPDATE business_subscriptions
       SET status = 'cancelled', cancelled_at = NOW(), cancel_reason = $1
       WHERE id = $2`,
      [reason || null, sub.id]
    )

    await auditLog({
      actorId: req.auth!.sub,
      actorType: 'business_member',
      action: 'subscription.cancelled',
      resourceType: 'business_subscription',
      resourceId: sub.id,
      newData: { reason },
      ip: req.ip,
      surface: 'business',
    })

    return success(res, { message: 'Subscription cancelled. Access continues until end of billing period.' })
  }
)

// ─── STAFF: Process driver withdrawal ─────────────────────────────────────────

paymentRouter.post(
  '/withdrawals/:withdrawalId/disburse',
  requireStaff,
  requirePermission('withdrawals.process'),
  async (req: Request, res: Response) => {
    const wr = await queryOne<any>(
      `SELECT wr.*, pm.account_number, pm.type as pm_type, pm.account_name,
              d.first_name, d.last_name, d.phone
       FROM withdrawal_requests wr
       JOIN driver_payment_methods pm ON pm.id = wr.payment_method_id
       JOIN drivers d ON d.id = wr.driver_id
       WHERE wr.id = $1 AND wr.status = 'approved'`,
      [req.params.withdrawalId]
    )
    if (!wr) throw new NotFoundError('Approved withdrawal request')

    const accountNumber = decrypt(wr.account_number)
    const accountBank = getAccountBank(wr.pm_type)
    const reference = `WTH-${Date.now()}-${generateToken(4).toUpperCase()}`

    const transfer = await initiateTransfer({
      amount: wr.net_ugx,
      currency: 'UGX',
      accountNumber,
      accountBank,
      beneficiaryName: `${wr.first_name} ${wr.last_name}`,
      narration: `Rheo driver earnings withdrawal`,
      reference,
    })

    const txRef = `TXN-WTH-${Date.now()}`
    await withTransaction(async (client) => {
      // Record transaction
      const [tx] = await client.query(
        `INSERT INTO transactions
          (type, status, driver_id, amount_ugx, fee_ugx, net_ugx,
           provider, provider_ref, description, reference, initiated_by, initiated_by_type)
         VALUES ('withdrawal','processing',$1,$2,$3,$4,'flutterwave',$5,$6,$7,$8,'staff')
         RETURNING id`,
        [
          wr.driver_id, wr.amount_ugx, wr.fee_ugx, wr.net_ugx,
          transfer.data?.id?.toString(), 'Driver earnings withdrawal',
          txRef, req.staffId,
        ]
      )

      // Update withdrawal request
      await client.query(
        `UPDATE withdrawal_requests
         SET status = 'processing', transaction_id = $1 WHERE id = $2`,
        [tx.rows[0].id, wr.id]
      )

      // Update wallet totals
      await client.query(
        `UPDATE driver_wallets
         SET total_withdrawn_ugx = total_withdrawn_ugx + $1 WHERE driver_id = $2`,
        [wr.amount_ugx, wr.driver_id]
      )
    })

    await sendNotification({
      recipientId: wr.driver_id,
      recipientType: 'driver',
      type: 'payment',
      title: 'Withdrawal Processing 💸',
      body: `Your withdrawal of ${wr.net_ugx.toLocaleString()} UGX is being sent to your account.`,
      sendPush: true,
      sendSms: true,
    })

    await auditLog({
      actorId: req.staffId,
      actorType: 'staff',
      actorRole: req.staffRole,
      action: 'withdrawal.disbursed',
      resourceType: 'withdrawal_request',
      resourceId: wr.id,
      newData: { amount: wr.net_ugx, reference, transferId: transfer.data?.id },
      ip: req.ip,
      surface: 'staff',
    })

    return success(res, { message: 'Transfer initiated', reference, transferId: transfer.data?.id })
  }
)

// ─── STAFF: List withdrawals ──────────────────────────────────────────────────

paymentRouter.get(
  '/withdrawals',
  requireStaff,
  requirePermission('withdrawals.process'),
  async (req: Request, res: Response) => {
    const { page = '1', limit = '20', status } = req.query as Record<string, string>
    const offset = (parseInt(page) - 1) * parseInt(limit)

    let where = 'WHERE 1=1'
    const params: any[] = []
    if (status) { params.push(status); where += ` AND wr.status = $${params.length}` }

    params.push(parseInt(limit), offset)
    const withdrawals = await query(
      `SELECT wr.id, wr.amount_ugx, wr.fee_ugx, wr.net_ugx, wr.status,
              wr.created_at, wr.approved_at,
              d.first_name, d.last_name, d.phone,
              pm.type as payment_type, pm.display_name as payment_display,
              s.first_name as approved_by_first, s.last_name as approved_by_last
       FROM withdrawal_requests wr
       JOIN drivers d ON d.id = wr.driver_id
       JOIN driver_payment_methods pm ON pm.id = wr.payment_method_id
       LEFT JOIN staff s ON s.id = wr.approved_by
       ${where}
       ORDER BY wr.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    )

    const [{ count }] = await query(
      `SELECT COUNT(*) FROM withdrawal_requests wr ${where}`, params.slice(0, -2)
    )
    return paginated(res, withdrawals, parseInt(count), parseInt(page), parseInt(limit))
  }
)

// ─── STAFF: List all transactions ─────────────────────────────────────────────

paymentRouter.get(
  '/transactions',
  requireStaff,
  requirePermission('transactions.*'),
  async (req: Request, res: Response) => {
    const { page = '1', limit = '20', type, status, from, to } = req.query as Record<string, string>
    const offset = (parseInt(page) - 1) * parseInt(limit)

    let where = 'WHERE 1=1'
    const params: any[] = []
    if (type)   { params.push(type);   where += ` AND t.type = $${params.length}` }
    if (status) { params.push(status); where += ` AND t.status = $${params.length}` }
    if (from)   { params.push(from);   where += ` AND t.created_at::date >= $${params.length}` }
    if (to)     { params.push(to);     where += ` AND t.created_at::date <= $${params.length}` }

    params.push(parseInt(limit), offset)
    const transactions = await query(
      `SELECT t.*,
              d.first_name as driver_first, d.last_name as driver_last,
              b.business_name
       FROM transactions t
       LEFT JOIN drivers d ON d.id = t.driver_id
       LEFT JOIN businesses b ON b.id = t.business_id
       ${where}
       ORDER BY t.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    )

    const [{ count }] = await query(
      `SELECT COUNT(*) FROM transactions t ${where}`, params.slice(0, -2)
    )
    return paginated(res, transactions, parseInt(count), parseInt(page), parseInt(limit))
  }
)

// ─── FLUTTERWAVE WEBHOOK ───────────────────────────────────────────────────────
// Must use raw body — mounted before express.json() in index.ts

paymentRouter.post(
  '/webhook/flutterwave',
  express.raw({ type: 'application/json' }),
  async (req: Request, res: Response) => {
    const signature = req.headers['verif-hash'] as string
    const rawBody = req.body.toString()

    if (!verifyWebhookSignature(rawBody, signature)) {
      logger.warn('Invalid Flutterwave webhook signature')
      return res.status(401).json({ error: 'Invalid signature' })
    }

    const event = JSON.parse(rawBody)
    logger.info('Flutterwave webhook received', { event: event.event, ref: event.data?.tx_ref })

    try {
      if (event.event === 'charge.completed') {
        await handleChargeCompleted(event.data)
      } else if (event.event === 'transfer.completed') {
        await handleTransferCompleted(event.data)
      }
    } catch (err: any) {
      logger.error('Webhook handler error', { error: err.message, event: event.event })
    }

    // Always return 200 to Flutterwave immediately
    return res.status(200).json({ received: true })
  }
)

async function handleChargeCompleted(data: any) {
  const { tx_ref, status, amount, currency, flw_ref } = data

  if (status !== 'successful') {
    await query(
      `UPDATE transactions SET status = 'failed', provider_response = $1 WHERE reference = $2`,
      [JSON.stringify(data), tx_ref]
    )
    return
  }

  // Verify with Flutterwave (never trust webhook alone)
  const verification = await verifyTransaction(data.id)
  if (verification.data?.status !== 'successful') {
    logger.warn('Transaction verification failed', { txRef: tx_ref })
    return
  }

  const tx = await queryOne<any>(
    `SELECT * FROM transactions WHERE reference = $1`, [tx_ref]
  )
  if (!tx) return

  await withTransaction(async (client) => {
    await client.query(
      `UPDATE transactions
       SET status = 'completed', provider_ref = $1, provider_response = $2, completed_at = NOW()
       WHERE reference = $3`,
      [flw_ref, JSON.stringify(data), tx_ref]
    )

    // If it's a subscription payment, activate the subscription
    if (tx.type === 'subscription_charge' && tx.business_id) {
      // Extract plan info from description or meta
      const metaMatch = tx_ref.match(/^SUB-/)
      if (metaMatch) {
        // Get pending plan info from the payment description
        const planName = tx.description.split(' ')[0].toLowerCase()

        const plan = await client.query(
          `SELECT * FROM subscription_plans WHERE display_name ILIKE $1`,
          [`%${planName}%`]
        )

        if (plan.rows[0]) {
          const periodEnd = new Date()
          const txRefParts = tx_ref.split('-')
          const isAnnual = tx.description.includes('annual')
          isAnnual
            ? periodEnd.setFullYear(periodEnd.getFullYear() + 1)
            : periodEnd.setMonth(periodEnd.getMonth() + 1)

          // Cancel existing subscription if any
          await client.query(
            `UPDATE business_subscriptions SET status = 'cancelled' WHERE business_id = $1 AND status = 'active'`,
            [tx.business_id]
          )

          // Create new subscription
          await client.query(
            `INSERT INTO business_subscriptions
              (business_id, plan_id, billing_cycle, amount_ugx, status, current_period_start, current_period_end)
             VALUES ($1, $2, $3, $4, 'active', NOW(), $5)`,
            [
              tx.business_id, plan.rows[0].id,
              isAnnual ? 'annual' : 'monthly',
              amount, periodEnd,
            ]
          )

          // Update business plan
          await client.query(
            `UPDATE businesses SET plan = $1, plan_renews_at = $2 WHERE id = $3`,
            [plan.rows[0].name, periodEnd, tx.business_id]
          )
        }
      }

      // Notify business
      await sendNotification({
        recipientId: tx.business_id,
        recipientType: 'business_member',
        type: 'payment',
        title: 'Subscription Activated ✅',
        body: `Your Rheo subscription is now active.`,
        sendPush: true,
        sendEmail: true,
      })
    }
  })

  logger.info('Charge completed and processed', { txRef: tx_ref, amount })
}

async function handleTransferCompleted(data: any) {
  const { reference, status } = data

  const newStatus = status === 'SUCCESSFUL' ? 'completed' : 'failed'

  await withTransaction(async (client) => {
    // Update transaction
    await client.query(
      `UPDATE transactions
       SET status = $1, provider_response = $2, completed_at = NOW()
       WHERE reference = $3`,
      [newStatus, JSON.stringify(data), reference]
    )

    // Update withdrawal request
    const [wr] = await client.query(
      `UPDATE withdrawal_requests wr
       SET status = $1
       FROM transactions t
       WHERE t.id = wr.transaction_id AND t.reference = $2
       RETURNING wr.driver_id, wr.net_ugx`,
      [newStatus, reference]
    )

    if (wr?.rows[0]) {
      const { driver_id, net_ugx } = wr.rows[0]

      if (newStatus === 'failed') {
        // Refund driver wallet on failed transfer
        await client.query(
          `UPDATE driver_wallets SET balance_ugx = balance_ugx + $1 WHERE driver_id = $2`,
          [net_ugx, driver_id]
        )
      }

      await sendNotification({
        recipientId: driver_id,
        recipientType: 'driver',
        type: 'payment',
        title: newStatus === 'completed' ? 'Withdrawal Successful 🎉' : 'Withdrawal Failed',
        body: newStatus === 'completed'
          ? `${parseFloat(net_ugx).toLocaleString()} UGX has been sent to your account.`
          : 'Your withdrawal failed. Funds have been returned to your wallet. Please try again.',
        sendPush: true,
        sendSms: true,
      })
    }
  })

  logger.info('Transfer webhook processed', { reference, status: newStatus })
}

// ─── SUBSCRIPTION PLANS (public) ─────────────────────────────────────────────

paymentRouter.get('/plans', async (req: Request, res: Response) => {
  const plans = await query(
    `SELECT id, name, display_name, monthly_price_ugx, annual_price_ugx,
            max_jobs_per_month, max_team_members, api_access,
            dedicated_support, custom_branding, features
     FROM subscription_plans WHERE is_active = true ORDER BY monthly_price_ugx ASC NULLS LAST`
  )
  return success(res, plans)
})
