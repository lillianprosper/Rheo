import { logger } from '../utils/logger'
import { AppError } from '../utils/errors'
import crypto from 'crypto'

// ─── Flutterwave payment service ──────────────────────────────────────────────
// STRIDE: Tampering — webhook payloads MUST be verified via HMAC-SHA256
//   signature before processing any payment state change.
// STRIDE: Repudiation — every transaction gets a unique txRef stored in DB.
//   Flutterwave's flw_ref is also stored for reconciliation.
// STRIDE: Denial of Service — all API calls have a 30s timeout.
//   Flutterwave SLA is typically <5s; 30s is generous for East African networks.
//
// Supported payment methods in Uganda:
//   MTN Mobile Money  — network: 'MTN'
//   Airtel Money      — network: 'AIRTEL'
//   Visa/Mastercard   — via Flutterwave hosted payment link

const FLW_BASE = 'https://api.flutterwave.com/v3'
const TIMEOUT_MS = 30_000

// ─── HTTP helper ──────────────────────────────────────────────────────────────

async function flwRequest<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>
): Promise<T> {
  const secretKey = process.env.FLUTTERWAVE_SECRET_KEY
  if (!secretKey) throw new AppError('FLUTTERWAVE_SECRET_KEY not configured', 500)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const response = await fetch(`${FLW_BASE}${path}`, {
      method,
      headers: {
        'Authorization': `Bearer ${secretKey}`,
        'Content-Type':  'application/json',
      },
      body:   body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })

    clearTimeout(timeout)

    const data = await response.json() as { status: string; message: string; data?: T }

    if (!response.ok || data.status !== 'success') {
      logger.error('Flutterwave API error', {
        path,
        status:  response.status,
        message: data.message,
      })
      throw new AppError(
        data.message || 'Payment provider error',
        response.status >= 500 ? 502 : 400,
        'PAYMENT_PROVIDER_ERROR'
      )
    }

    return data.data as T

  } catch (err: any) {
    clearTimeout(timeout)
    if (err instanceof AppError) throw err
    if (err.name === 'AbortError') {
      throw new AppError('Payment request timed out. Please try again.', 504, 'PAYMENT_TIMEOUT')
    }
    logger.error('Flutterwave unexpected error', { path, error: err.message })
    throw new AppError('Payment service unavailable', 502, 'PAYMENT_UNAVAILABLE')
  }
}

// ─── Mobile Money charge ──────────────────────────────────────────────────────

export interface MobileMoneyOpts {
  amount:      number        // in UGX
  currency:    'UGX'
  phone:       string        // E.164 format (+256...)
  network:     'MTN' | 'AIRTEL'
  email:       string
  name:        string
  txRef:       string        // your unique reference — store in DB before calling
  narration:   string
}

export interface MobileMoneyResult {
  flwRef:      string
  txRef:       string
  status:      string
  message:     string
}

/**
 * Initiate a mobile money charge (MTN MoMo or Airtel Money).
 * The customer receives a USSD push prompt on their phone to approve.
 * Poll verifyTransaction() or wait for webhook to confirm completion.
 */
export async function chargeMobileMoney(
  opts: MobileMoneyOpts
): Promise<MobileMoneyResult> {
  logger.info('Initiating mobile money charge', {
    txRef:   opts.txRef,
    network: opts.network,
    amount:  opts.amount,
  })

  const result = await flwRequest<{
    flw_ref: string
    tx_ref:  string
    status:  string
    message: string
  }>('POST', '/charges?type=mobile_money_uganda', {
    amount:    opts.amount,
    currency:  opts.currency,
    phone_number: opts.phone,
    network:   opts.network,
    email:     opts.email,
    fullname:  opts.name,
    tx_ref:    opts.txRef,
    narration: opts.narration,
  })

  return {
    flwRef:  result.flw_ref,
    txRef:   result.tx_ref,
    status:  result.status,
    message: result.message,
  }
}

// ─── Transaction verification ─────────────────────────────────────────────────

export interface VerifyResult {
  id:          number
  txRef:       string
  flwRef:      string
  status:      'successful' | 'failed' | 'pending'
  amount:      number
  currency:    string
  paymentType: string
}

/**
 * Verify a transaction by Flutterwave ID.
 * ALWAYS verify amount and currency match what you expect.
 * Never trust webhook payload amount alone — verify via API.
 */
export async function verifyTransaction(
  flwTransactionId: number | string,
  expectedAmount:   number,
  expectedCurrency: string
): Promise<VerifyResult> {
  const result = await flwRequest<{
    id:           number
    tx_ref:       string
    flw_ref:      string
    status:       string
    amount:       number
    currency:     string
    payment_type: string
  }>('GET', `/transactions/${flwTransactionId}/verify`)

  // Critical: verify amount + currency match to prevent partial-payment attacks
  if (result.status === 'successful') {
    if (result.amount < expectedAmount) {
      logger.error('Payment amount mismatch', {
        expected: expectedAmount,
        received: result.amount,
        txRef:    result.tx_ref,
      })
      throw new AppError(
        `Payment amount mismatch: expected ${expectedAmount}, received ${result.amount}`,
        402,
        'PAYMENT_AMOUNT_MISMATCH'
      )
    }
    if (result.currency !== expectedCurrency) {
      throw new AppError(
        `Currency mismatch: expected ${expectedCurrency}, received ${result.currency}`,
        402,
        'PAYMENT_CURRENCY_MISMATCH'
      )
    }
  }

  return {
    id:          result.id,
    txRef:       result.tx_ref,
    flwRef:      result.flw_ref,
    status:      result.status as VerifyResult['status'],
    amount:      result.amount,
    currency:    result.currency,
    paymentType: result.payment_type,
  }
}

// ─── Webhook signature verification ──────────────────────────────────────────

/**
 * Verify a Flutterwave webhook signature.
 * STRIDE: Tampering — reject any webhook that doesn't carry the correct
 * HMAC-SHA256 signature. This prevents attackers from faking payment events.
 *
 * Flutterwave sends the signature in the `verif-hash` header.
 * The secret is your FLUTTERWAVE_WEBHOOK_SECRET env var.
 */
export function verifyWebhookSignature(
  payload:   string,  // raw request body as string (before JSON.parse)
  signature: string   // value of `verif-hash` header
): boolean {
  const secret = process.env.FLUTTERWAVE_WEBHOOK_SECRET
  if (!secret) {
    logger.error('FLUTTERWAVE_WEBHOOK_SECRET not configured')
    return false
  }

  try {
    const expected = crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('hex')

    // Constant-time comparison prevents timing attacks
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected)
    )
  } catch {
    return false
  }
}

// ─── Transfer (driver payout) ─────────────────────────────────────────────────

export interface TransferOpts {
  amount:        number
  currency:      'UGX'
  accountNumber: string        // mobile money number in E.164
  accountName:   string
  network:       'MTN' | 'AIRTEL'
  narration:     string
  reference:     string        // your unique reference
}

export interface TransferResult {
  id:        number
  reference: string
  status:    string
}

/**
 * Initiate a transfer to a driver's mobile money account.
 * Used for withdrawal payouts. Requires Flutterwave transfer balance.
 * Poll or listen for webhook to confirm final status.
 */
export async function initiateTransfer(opts: TransferOpts): Promise<TransferResult> {
  logger.info('Initiating driver payout transfer', {
    reference: opts.reference,
    amount:    opts.amount,
    network:   opts.network,
  })

  const result = await flwRequest<{
    id:        number
    reference: string
    status:    string
  }>('POST', '/transfers', {
    account_bank:    opts.network === 'MTN' ? 'MPS' : 'AIRTEL',  // FLW bank codes for UG MoMo
    account_number:  opts.accountNumber,
    amount:          opts.amount,
    currency:        opts.currency,
    narration:       opts.narration,
    reference:       opts.reference,
    beneficiary_name: opts.accountName,
    debit_currency:  'UGX',
  })

  return {
    id:        result.id,
    reference: result.reference,
    status:    result.status,
  }
}

// ─── Payment link (card payments) ─────────────────────────────────────────────

export interface PaymentLinkOpts {
  amount:    number
  currency:  'UGX'
  txRef:     string
  email:     string
  name:      string
  narration: string
  redirectUrl: string
}

/**
 * Generate a Flutterwave hosted payment link for card payments (Visa/Mastercard).
 * Customer is redirected to Flutterwave's hosted page to complete payment.
 * On completion, Flutterwave redirects to your redirectUrl with txRef param.
 */
export async function createPaymentLink(opts: PaymentLinkOpts): Promise<string> {
  const result = await flwRequest<{ link: string }>('POST', '/payments', {
    tx_ref:       opts.txRef,
    amount:       opts.amount,
    currency:     opts.currency,
    redirect_url: opts.redirectUrl,
    customer: {
      email: opts.email,
      name:  opts.name,
    },
    customizations: {
      title:       'Rheo Transport',
      description: opts.narration,
      logo:        'https://rheo.co/logo.png',
    },
  })

  return result.link
}
