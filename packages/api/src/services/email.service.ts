import { logger } from '../utils/logger'

// ─── SendGrid email service ───────────────────────────────────────────────────
// STRIDE: Information Disclosure — emails contain OTPs and account details.
// Never log full email body — only recipient and template name.
// STRIDE: Denial of Service — SendGrid has rate limits per plan.
// High-volume notification blasts should use the SendGrid batch API, not
// this single-send wrapper. This service is for transactional emails only.
//
// Templates are defined in SendGrid Dynamic Templates (not hardcoded HTML).
// Each templateId maps to a SendGrid template that accepts a `data` object.

// ─── Template registry ────────────────────────────────────────────────────────
// Add new templates here + create matching Dynamic Template in SendGrid dashboard.
// Template IDs from SendGrid dashboard: Settings → Email API → Dynamic Templates

const TEMPLATES: Record<string, string> = {
  business_welcome:     process.env.SG_TEMPLATE_BUSINESS_WELCOME     || '',
  password_reset:       process.env.SG_TEMPLATE_PASSWORD_RESET       || '',
  email_verification:   process.env.SG_TEMPLATE_EMAIL_VERIFY         || '',
  job_created:          process.env.SG_TEMPLATE_JOB_CREATED         || '',
  job_delivered:        process.env.SG_TEMPLATE_JOB_DELIVERED       || '',
  subscription_invoice: process.env.SG_TEMPLATE_INVOICE             || '',
  driver_approved:      process.env.SG_TEMPLATE_DRIVER_APPROVED     || '',
  driver_rejected:      process.env.SG_TEMPLATE_DRIVER_REJECTED     || '',
  staff_invite:         process.env.SG_TEMPLATE_STAFF_INVITE        || '',
  withdrawal_processed: process.env.SG_TEMPLATE_WITHDRAWAL          || '',
}

export type EmailTemplate = keyof typeof TEMPLATES

export interface EmailOptions {
  to:       string | string[]
  template: EmailTemplate
  data:     Record<string, unknown>   // passed as SendGrid dynamic template data
  subject?: string                    // optional override — template usually sets this
  from?:    string                    // optional override — defaults to FROM_EMAIL env
}

export interface EmailResult {
  success:   boolean
  messageId?: string
  error?:    string
}

// ─── Send ─────────────────────────────────────────────────────────────────────

/**
 * Send a transactional email via SendGrid Dynamic Templates.
 * Never throws — returns { success: false, error } on failure.
 * In non-production, logs the email content instead of sending.
 */
export async function sendEmail(opts: EmailOptions): Promise<EmailResult> {
  const from = opts.from || process.env.SENDGRID_FROM_EMAIL || 'noreply@rheo.co'
  const recipients = Array.isArray(opts.to) ? opts.to : [opts.to]

  // ── Dev/test mode ──────────────────────────────────────────────────────────
  if (process.env.NODE_ENV !== 'production') {
    logger.info('📧 [DEV] Email (not sent)', {
      to:       recipients,
      template: opts.template,
      data:     opts.data,
    })
    return { success: true, messageId: `dev-${Date.now()}` }
  }

  // ── Production ─────────────────────────────────────────────────────────────
  const apiKey = process.env.SENDGRID_API_KEY
  if (!apiKey) {
    logger.error('SENDGRID_API_KEY not configured')
    return { success: false, error: 'Email service not configured' }
  }

  const templateId = TEMPLATES[opts.template]
  if (!templateId) {
    logger.error('Unknown email template', { template: opts.template })
    return { success: false, error: `Unknown template: ${opts.template}` }
  }

  const payload = {
    personalizations: recipients.map((email) => ({
      to:               [{ email }],
      dynamic_template_data: opts.data,
    })),
    from:        { email: from, name: 'Rheo Transport' },
    template_id: templateId,
    // Override subject only if explicitly provided — template default is preferred
    ...(opts.subject ? { subject: opts.subject } : {}),
  }

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)

    const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
      },
      body:   JSON.stringify(payload),
      signal: controller.signal,
    })

    clearTimeout(timeout)

    // SendGrid returns 202 Accepted on success (no body)
    if (response.status === 202) {
      const messageId = response.headers.get('X-Message-Id') || undefined
      logger.info('Email sent', { to: recipients, template: opts.template, messageId })
      return { success: true, messageId }
    }

    // Parse error body for logging — never expose to client
    const errorBody = await response.json().catch(() => ({})) as {
      errors?: Array<{ message: string }>
    }
    const errorMsg = errorBody.errors?.[0]?.message || `HTTP ${response.status}`
    logger.error('SendGrid API error', {
      status:   response.status,
      error:    errorMsg,
      template: opts.template,
      // Log only domain of recipient, not full email address
      toDomain: recipients.map((e) => e.split('@')[1]),
    })
    return { success: false, error: `Email delivery failed: ${errorMsg}` }

  } catch (err: any) {
    if (err.name === 'AbortError') {
      logger.error('SendGrid request timed out', { template: opts.template })
      return { success: false, error: 'Email service timed out' }
    }
    logger.error('SendGrid unexpected error', { error: err.message, template: opts.template })
    return { success: false, error: 'Email service unavailable' }
  }
}

// ─── Email template helpers ───────────────────────────────────────────────────
// Typed wrappers so route handlers don't pass raw data objects.

export const emails = {
  businessWelcome: (to: string, data: { businessName: string; otp: string }) =>
    sendEmail({ to, template: 'business_welcome', data }),

  passwordReset: (to: string, data: { otp: string; expiresIn: string }) =>
    sendEmail({ to, template: 'password_reset', data }),

  emailVerification: (to: string, data: { otp: string }) =>
    sendEmail({ to, template: 'email_verification', data }),

  driverApproved: (to: string, data: { firstName: string }) =>
    sendEmail({ to, template: 'driver_approved', data }),

  driverRejected: (to: string, data: { firstName: string; reason: string }) =>
    sendEmail({ to, template: 'driver_rejected', data }),

  staffInvite: (to: string, data: { firstName: string; tempPassword: string; role: string }) =>
    sendEmail({ to, template: 'staff_invite', data }),

  subscriptionInvoice: (to: string, data: {
    businessName: string
    invoiceNumber: string
    amount: string
    dueDate: string
    pdfUrl?: string
  }) => sendEmail({ to, template: 'subscription_invoice', data }),

  withdrawalProcessed: (to: string, data: { firstName: string; amount: string }) =>
    sendEmail({ to, template: 'withdrawal_processed', data }),
}
