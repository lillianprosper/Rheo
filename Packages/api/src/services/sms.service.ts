import { logger } from '../utils/logger'

// ─── Africa's Talking SMS service ────────────────────────────────────────────
// STRIDE: Denial of Service — AT charges per SMS. Rate limiting at the
// route level (otpLimiter) is the first line of defense. This service
// is a thin wrapper that never throws — a failed SMS must not crash a
// registration flow. The caller decides whether to surface the failure.
//
// Uganda phone formats accepted:
//   +256712345678  (international)
//   0712345678     (local with leading 0)
//   712345678      (local without 0)
// All normalized to +256 before sending.

export interface SMSResult {
  success: boolean
  messageId?: string
  cost?:      string
  error?:     string
}

// ─── Phone normalization ──────────────────────────────────────────────────────

/**
 * Normalize a Uganda phone number to E.164 format (+256XXXXXXXXX).
 * Africa's Talking requires E.164.
 */
export function normalizeUgandaPhone(raw: string): string {
  // Strip spaces, dashes, parentheses
  const cleaned = raw.replace(/[\s\-().]/g, '')

  if (cleaned.startsWith('+256')) return cleaned
  if (cleaned.startsWith('256'))  return `+${cleaned}`
  if (cleaned.startsWith('0'))    return `+256${cleaned.slice(1)}`
  if (cleaned.length === 9)       return `+256${cleaned}`

  // Return as-is if we can't confidently normalize — AT will reject it
  // and we'll log the error
  return cleaned
}

// ─── SMS sender ───────────────────────────────────────────────────────────────

/**
 * Send an SMS via Africa's Talking.
 * Never throws — returns { success: false, error } on any failure.
 * In development/test, logs the message instead of hitting the AT API.
 */
export async function sendSMS(opts: {
  to:      string
  message: string
}): Promise<SMSResult> {
  const phone   = normalizeUgandaPhone(opts.to)
  const message = opts.message.slice(0, 160) // Hard SMS char limit

  // ── Dev/test mode — log instead of sending ─────────────────────────────────
  if (process.env.NODE_ENV !== 'production') {
    logger.info('📱 [DEV] SMS (not sent)', { to: phone, message })
    return { success: true, messageId: `dev-${Date.now()}` }
  }

  // ── Production — hit Africa's Talking REST API ─────────────────────────────
  const apiKey  = process.env.AT_API_KEY
  const username = process.env.AT_USERNAME
  const senderId = process.env.AT_SENDER_ID || 'RHEO'

  if (!apiKey || !username) {
    logger.error('Africa\'s Talking credentials not configured')
    return { success: false, error: 'SMS service not configured' }
  }

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000) // 15s timeout

    const body = new URLSearchParams({
      username,
      to:      phone,
      message,
      from:    senderId,
    })

    const response = await fetch('https://api.africastalking.com/version1/messaging', {
      method:  'POST',
      headers: {
        'apiKey':       apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept':       'application/json',
      },
      body:   body.toString(),
      signal: controller.signal,
    })

    clearTimeout(timeout)

    if (!response.ok) {
      const text = await response.text()
      logger.error('AT SMS API error', { status: response.status, body: text, phone })
      return { success: false, error: `SMS provider error: ${response.status}` }
    }

    const data = await response.json() as {
      SMSMessageData?: {
        Recipients?: Array<{
          messageId: string
          cost:      string
          status:    string
          number:    string
        }>
      }
    }

    const recipient = data.SMSMessageData?.Recipients?.[0]
    if (!recipient || recipient.status !== 'Success') {
      logger.warn('AT SMS delivery failed', { phone, recipient })
      return { success: false, error: recipient?.status || 'Unknown delivery failure' }
    }

    logger.info('SMS sent', { to: phone, messageId: recipient.messageId, cost: recipient.cost })
    return { success: true, messageId: recipient.messageId, cost: recipient.cost }

  } catch (err: any) {
    if (err.name === 'AbortError') {
      logger.error('AT SMS request timed out', { phone })
      return { success: false, error: 'SMS request timed out' }
    }
    logger.error('AT SMS unexpected error', { phone, error: err.message })
    return { success: false, error: 'SMS service unavailable' }
  }
}

// ─── SMS templates ────────────────────────────────────────────────────────────
// Centralizing templates prevents message drift across the codebase.

export const smsTemplates = {
  driverWelcome: (firstName: string) =>
    `Hi ${firstName}! Welcome to Rheo. Download the driver app to complete your application: https://rheo.co/driver-app`,

  driverApproved: (firstName: string) =>
    `Congratulations ${firstName}! Your Rheo driver account is approved. Open the app to start accepting jobs.`,

  driverSuspended: (firstName: string) =>
    `Hi ${firstName}, your Rheo account has been suspended. Contact support: support@rheo.co`,

  jobAssigned: (jobRef: string) =>
    `New job ${jobRef} assigned to you. Open the Rheo app to view details and accept.`,

  withdrawalProcessed: (amount: string) =>
    `Your Rheo withdrawal of UGX ${amount} has been processed. Check your mobile money account.`,

  otpReset: (otp: string) =>
    `Your Rheo password reset code is ${otp}. Expires in 15 minutes. Do not share this code.`,
}
