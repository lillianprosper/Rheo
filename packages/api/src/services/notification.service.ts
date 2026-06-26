import { query, queryOne } from '../config/database'
import { logger } from '../utils/logger'
import { sendSMS } from './sms.service'
import { sendEmail } from './email.service'

export type RecipientType = 'driver' | 'business_member' | 'staff'
export type NotificationType =
  | 'job_assigned' | 'job_update' | 'payment'
  | 'account' | 'system' | 'promotion'

export interface SendNotificationOpts {
  recipientId:    string
  recipientType:  RecipientType
  type:           NotificationType
  title:          string
  body:           string
  data?:          Record<string, unknown>
  sendPush?:      boolean
  sendSMS?:       boolean
  sendEmail?:     boolean
  phone?:         string
  email?:         string
  smsMessage?:    string
  emailTemplate?: string
  emailData?:     Record<string, unknown>
}

export interface NotificationResult {
  notificationId: string
  pushSent:       boolean
  smsSent:        boolean
  emailSent:      boolean
}

export async function sendNotification(opts: SendNotificationOpts): Promise<NotificationResult> {
  const {
    recipientId, recipientType, type, title, body,
    data      = {},
    sendPush  = true,
    sendSMS:  doSMS   = false,
    sendEmail: doEmail = false,
  } = opts

  let notificationId: string

  try {
    const row = await queryOne<{ id: string }>(
      `INSERT INTO notifications
         (type, title, body, data, recipient_id, recipient_type,
          send_push, send_sms, send_email)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id`,
      [type, title, body, JSON.stringify(data), recipientId, recipientType,
       sendPush, doSMS, doEmail]
    )
    notificationId = row!.id
  } catch (err: any) {
    logger.error('Failed to persist notification', { recipientId, type, error: err.message })
    return { notificationId: '', pushSent: false, smsSent: false, emailSent: false }
  }

  const result: NotificationResult = { notificationId, pushSent: false, smsSent: false, emailSent: false }

  if (sendPush) {
    result.pushSent = await sendPushNotification(recipientId, title, body, data)
    if (result.pushSent) {
      await query(`UPDATE notifications SET push_sent_at = NOW() WHERE id = $1`, [notificationId])
    }
  }

  if (doSMS && opts.phone && opts.smsMessage) {
    const smsResult = await sendSMS({ to: opts.phone, message: opts.smsMessage })
    result.smsSent = smsResult.success
    if (result.smsSent) {
      await query(`UPDATE notifications SET sms_sent_at = NOW() WHERE id = $1`, [notificationId])
    }
  }

  if (doEmail && opts.email && opts.emailTemplate) {
    const emailResult = await sendEmail({
      to:       opts.email,
      template: opts.emailTemplate as Parameters<typeof sendEmail>[0]['template'],
      data:     opts.emailData || {},
    })
    result.emailSent = emailResult.success
    if (result.emailSent) {
      await query(`UPDATE notifications SET email_sent_at = NOW() WHERE id = $1`, [notificationId])
    }
  }

  logger.info('Notification dispatched', { notificationId, recipientId, type, pushSent: result.pushSent, smsSent: result.smsSent, emailSent: result.emailSent })
  return result
}

// ─── Push via Firebase Admin (modular SDK v12) ────────────────────────────────

async function sendPushNotification(
  recipientId: string,
  title: string,
  body: string,
  data: Record<string, unknown>
): Promise<boolean> {
  try {
    const tokens = await query<{ id: string; token: string }>(
      `SELECT pt.id, pt.token
       FROM push_tokens pt
       JOIN auth_users u ON u.id = pt.user_id
       WHERE pt.is_active = true
         AND u.id IN (
           SELECT auth_user_id FROM drivers          WHERE id = $1
           UNION ALL
           SELECT auth_user_id FROM business_members WHERE id = $1
           UNION ALL
           SELECT auth_user_id FROM staff            WHERE id = $1
         )`,
      [recipientId]
    )

    if (tokens.length === 0) return false

    const fb = await getFirebaseAdmin()
    if (!fb) return false

    const stringData: Record<string, string> = {}
    for (const [k, v] of Object.entries(data)) stringData[k] = String(v)

    const results = await Promise.allSettled(
      tokens.map((t) =>
        fb.sendMessage({
          token:        t.token,
          notification: { title, body },
          data:         stringData,
          android:      { priority: 'high' },
          apns:         { payload: { aps: { sound: 'default', badge: 1 } } },
        })
      )
    )

    const invalidIds: string[] = []
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        const code = (r.reason as any)?.errorInfo?.code as string | undefined
        if (code?.includes('not-registered') || code?.includes('invalid-registration')) {
          invalidIds.push(tokens[i].id)
        }
      }
    })

    if (invalidIds.length > 0) {
      await query(`UPDATE push_tokens SET is_active = false WHERE id = ANY($1)`, [invalidIds])
    }

    return results.some((r) => r.status === 'fulfilled')
  } catch (err: any) {
    logger.error('Push notification error', { recipientId, error: err.message })
    return false
  }
}

// ─── Firebase Admin lazy loader (modular v12 API) ─────────────────────────────

let _fbSendMessage: ((msg: object) => Promise<string>) | null = null

async function getFirebaseAdmin(): Promise<{ sendMessage: (msg: object) => Promise<string> } | null> {
  if (_fbSendMessage) return { sendMessage: _fbSendMessage }

  const projectId   = process.env.FIREBASE_PROJECT_ID
  const privateKey  = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n')
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL

  if (!projectId || !privateKey || !clientEmail) {
    logger.warn('Firebase credentials not configured — push disabled')
    return null
  }

  try {
    const { initializeApp, getApps, cert }   = await import('firebase-admin/app')
    const { getMessaging }                   = await import('firebase-admin/messaging')

    if (getApps().length === 0) {
      initializeApp({ credential: cert({ projectId, privateKey, clientEmail }) })
    }

    const messaging   = getMessaging()
    _fbSendMessage    = (msg) => messaging.send(msg as any)
    return { sendMessage: _fbSendMessage }
  } catch (err: any) {
    logger.error('Firebase Admin init failed', { error: err.message })
    return null
  }
}

// ─── Read helpers ─────────────────────────────────────────────────────────────

export async function markNotificationRead(notificationId: string, recipientId: string): Promise<boolean> {
  const result = await query(
    `UPDATE notifications SET read_at = NOW()
     WHERE id = $1 AND recipient_id = $2 AND read_at IS NULL RETURNING id`,
    [notificationId, recipientId]
  )
  return result.length > 0
}

export async function markAllNotificationsRead(recipientId: string, recipientType: RecipientType): Promise<number> {
  const result = await query(
    `UPDATE notifications SET read_at = NOW()
     WHERE recipient_id = $1 AND recipient_type = $2 AND read_at IS NULL RETURNING id`,
    [recipientId, recipientType]
  )
  return result.length
}

export async function getUnreadCount(recipientId: string, recipientType: RecipientType): Promise<number> {
  const row = await queryOne<{ count: string }>(
    `SELECT COUNT(*) as count FROM notifications
     WHERE recipient_id = $1 AND recipient_type = $2 AND read_at IS NULL`,
    [recipientId, recipientType]
  )
  return parseInt(row?.count || '0')
}
