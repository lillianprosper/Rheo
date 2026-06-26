import { query } from '../config/database'
import { logger } from './logger'

// ─── Audit log writer ─────────────────────────────────────────────────────────
// STRIDE: Repudiation — every significant action is recorded immutably.
// The audit_logs table has DB-level rules preventing UPDATE and DELETE.
// This function must NEVER throw — a failed audit write should not
// break the operation that triggered it. Errors are logged and swallowed.
//
// Usage: fire-and-forget. Do not await in hot paths.
//   auditLog({ actorId: staff.id, actorType: 'staff', action: 'driver.approve', ... })

export interface AuditPayload {
  actorId?:      string
  actorType:     'staff' | 'driver' | 'business_member' | 'system'
  actorRole?:    string
  action:        string          // e.g. 'driver.approve', 'auth.login', 'job.cancel'
  resourceType?: string          // e.g. 'driver', 'job', 'business'
  resourceId?:   string
  oldData?:      Record<string, unknown>
  newData?:      Record<string, unknown>
  ip?:           string
  userAgent?:    string
  surface?:      string
  metadata?:     Record<string, unknown>
}

export async function auditLog(payload: AuditPayload): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_logs
        (actor_id, actor_type, actor_role, action, resource_type, resource_id,
         old_data, new_data, ip_address, user_agent, surface, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        payload.actorId   ?? null,
        payload.actorType,
        payload.actorRole ?? null,
        payload.action,
        payload.resourceType ?? null,
        payload.resourceId   ?? null,
        payload.oldData  ? JSON.stringify(payload.oldData)  : null,
        payload.newData  ? JSON.stringify(payload.newData)  : null,
        payload.ip       ?? null,
        payload.userAgent ?? null,
        payload.surface  ?? null,
        payload.metadata ? JSON.stringify(payload.metadata) : null,
      ]
    )
  } catch (err: any) {
    // Non-blocking: log the failure but never surface it to the caller
    logger.error('Audit log write failed', {
      action: payload.action,
      actorId: payload.actorId,
      error: err.message,
    })
  }
}
