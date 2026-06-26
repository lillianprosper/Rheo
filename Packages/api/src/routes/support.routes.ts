import { Router, Request, Response } from 'express'
import { z } from 'zod'

import { query, queryOne } from '../config/database'
import { authenticate, requirePermission } from '../middleware/rbac'
import { AppError, NotFoundError, success, paginated } from '../utils/errors'
import { auditLog } from '../utils/audit'
import { sendNotification } from '../services/notification.service'

export const supportRouter = Router()

const requireDriver   = authenticate('driver')
const requireBusiness = authenticate('business')
const requireStaff    = authenticate('staff')

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getRaiseByColumn(surface: string): string {
  if (surface === 'driver')   return 'raised_by_driver'
  if (surface === 'business') return 'raised_by_member'
  return 'raised_by_staff'
}

// Verify caller owns or is staff for a ticket
async function assertTicketAccess(
  ticketId: string,
  callerId: string,
  surface:  string
): Promise<{ id: string; status: string; assigned_to: string | null }> {
  const ticket = await queryOne<{
    id: string; status: string; assigned_to: string | null
    raised_by_driver: string | null
    raised_by_member: string | null
    raised_by_staff:  string | null
  }>(
    `SELECT id, status, assigned_to,
            raised_by_driver, raised_by_member, raised_by_staff
     FROM support_tickets WHERE id = $1`,
    [ticketId]
  )
  if (!ticket) throw new NotFoundError('Ticket')

  if (surface === 'staff') return ticket

  const ownerId =
    surface === 'driver'   ? ticket.raised_by_driver :
    surface === 'business' ? ticket.raised_by_member : null

  if (ownerId !== callerId) throw new AppError('Access denied to this ticket', 403)
  return ticket
}

// ─── ANY AUTHENTICATED: Create ticket ────────────────────────────────────────
// All three surfaces can open tickets — middleware determines which column to populate

async function createTicket(req: Request, res: Response, surface: string) {
  const schema = z.object({
    subject:     z.string().min(5).max(200),
    description: z.string().min(10),
    category:    z.string().optional(),
    priority:    z.enum(['low', 'medium', 'high']).default('medium'),
    jobId:       z.string().uuid().optional(),
  })
  const data = schema.parse(req.body)

  const callerId = surface === 'driver'
    ? req.driverId
    : surface === 'business'
    ? req.staffId   // business member id is stored in staffId on the request
    : req.staffId

  const raiseCol = getRaiseByColumn(surface)

  const ticket = await queryOne<{ id: string; ticket_ref: string }>(
    `INSERT INTO support_tickets
       (subject, description, category, priority, job_id, ${raiseCol})
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, ticket_ref`,
    [data.subject, data.description, data.category ?? null,
     data.priority, data.jobId ?? null, callerId]
  )

  await auditLog({
    actorId: callerId, actorType: surface === 'driver' ? 'driver' : 'business_member',
    action: 'support.ticket_created',
    resourceType: 'support_ticket', resourceId: ticket!.id,
    newData: { subject: data.subject, priority: data.priority },
  })

  return success(res, { ticketId: ticket!.id, ticketRef: ticket!.ticket_ref }, 201)
}

supportRouter.post('/', requireDriver, (req, res) => createTicket(req, res, req.auth!.surface))

// ─── DRIVER: Own tickets ──────────────────────────────────────────────────────

supportRouter.get('/mine', requireDriver, async (req: Request, res: Response) => {
  const { page = '1', limit = '10' } = req.query as Record<string, string>
  const offset = (parseInt(page) - 1) * parseInt(limit)

  const tickets = await query(
    `SELECT id, ticket_ref, subject, status, priority, category, created_at, updated_at
     FROM support_tickets
     WHERE raised_by_driver = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [req.driverId, parseInt(limit), offset]
  )
  const [{ count }] = await query<{ count: string }>(
    `SELECT COUNT(*) FROM support_tickets WHERE raised_by_driver = $1`, [req.driverId]
  )
  return paginated(res, tickets, parseInt(count), parseInt(page), parseInt(limit))
})

// ─── BUSINESS: Own tickets ────────────────────────────────────────────────────

supportRouter.get('/business', requireBusiness, async (req: Request, res: Response) => {
  const { page = '1', limit = '10', status } = req.query as Record<string, string>
  const offset = (parseInt(page) - 1) * parseInt(limit)

  let where = 'WHERE raised_by_member = $1'
  const params: unknown[] = [req.staffId]

  if (status) { params.push(status); where += ` AND status = $${params.length}` }

  const tickets = await query(
    `SELECT id, ticket_ref, subject, status, priority, category, created_at, updated_at
     FROM support_tickets ${where}
     ORDER BY created_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, parseInt(limit), offset]
  )
  const [{ count }] = await query<{ count: string }>(
    `SELECT COUNT(*) FROM support_tickets ${where}`, params
  )
  return paginated(res, tickets, parseInt(count), parseInt(page), parseInt(limit))
})

// ─── OWNER/STAFF: Ticket detail + thread ──────────────────────────────────────

supportRouter.get('/:id', requireDriver, async (req: Request, res: Response) => {
  const surface  = req.auth!.surface
  const callerId = surface === 'driver' ? req.driverId! : req.staffId!

  const ticket = await assertTicketAccess(req.params.id, callerId, surface)

  const messages = await query(
    `SELECT id, message, author_id, author_type,
            CASE WHEN $1 = 'staff' THEN is_internal ELSE false END as is_internal,
            attachments, created_at
     FROM support_messages
     WHERE ticket_id = $2
       AND (is_internal = false OR $1 = 'staff')
     ORDER BY created_at ASC`,
    [surface, req.params.id]
  )

  return success(res, { ticket, messages })
})

// ─── OWNER/STAFF: Reply to ticket ────────────────────────────────────────────

supportRouter.post('/:id/messages', requireDriver, async (req: Request, res: Response) => {
  const surface  = req.auth!.surface
  const callerId = surface === 'driver' ? req.driverId! : req.staffId!

  const { message, isInternal } = z.object({
    message:    z.string().min(1).max(5000),
    isInternal: z.boolean().default(false),
  }).parse(req.body)

  // Internal notes only for staff
  if (isInternal && surface !== 'staff') {
    throw new AppError('Only staff can post internal notes', 403)
  }

  const ticket = await assertTicketAccess(req.params.id, callerId, surface)
  if (ticket.status === 'closed') throw new AppError('Cannot reply to a closed ticket', 400)

  const authorType =
    surface === 'driver'   ? 'driver' :
    surface === 'business' ? 'business_member' : 'staff'

  const msg = await queryOne<{ id: string }>(
    `INSERT INTO support_messages (ticket_id, message, author_id, author_type, is_internal)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [req.params.id, message, callerId, authorType, isInternal]
  )

  // Update ticket timestamp
  await query(
    `UPDATE support_tickets SET updated_at = NOW() WHERE id = $1`,
    [req.params.id]
  )

  // Notify the other party (staff notifies customer, customer notifies staff)
  if (surface === 'staff' && ticket.assigned_to) {
    // Staff replied — notify the ticket owner (handled by job, not inline)
  }

  return success(res, { messageId: msg!.id }, 201)
})

// ─── STAFF: All tickets ───────────────────────────────────────────────────────

supportRouter.get(
  '/',
  requireStaff,
  requirePermission('support.*'),
  async (req: Request, res: Response) => {
    const { page = '1', limit = '20', status, priority, assignedTo, search } =
      req.query as Record<string, string>
    const offset = (parseInt(page) - 1) * parseInt(limit)

    const params: unknown[] = []
    let where = 'WHERE 1=1'

    if (status)     { params.push(status);     where += ` AND t.status = $${params.length}` }
    if (priority)   { params.push(priority);   where += ` AND t.priority = $${params.length}` }
    if (assignedTo) { params.push(assignedTo); where += ` AND t.assigned_to = $${params.length}` }
    if (search) {
      params.push(`%${search}%`)
      where += ` AND (t.subject ILIKE $${params.length} OR t.ticket_ref ILIKE $${params.length})`
    }

    params.push(parseInt(limit), offset)
    const tickets = await query(
      `SELECT t.id, t.ticket_ref, t.subject, t.status, t.priority,
              t.category, t.created_at, t.updated_at,
              COALESCE(
                d.first_name || ' ' || d.last_name,
                bm.first_name || ' ' || bm.last_name
              ) as raised_by_name,
              s.first_name || ' ' || s.last_name as assigned_to_name
       FROM support_tickets t
       LEFT JOIN drivers d          ON d.id  = t.raised_by_driver
       LEFT JOIN business_members bm ON bm.id = t.raised_by_member
       LEFT JOIN staff s            ON s.id  = t.assigned_to
       ${where}
       ORDER BY
         CASE t.priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2
                         WHEN 'medium'   THEN 3 WHEN 'low'  THEN 4 END,
         t.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    )

    const [{ count }] = await query<{ count: string }>(
      `SELECT COUNT(*) FROM support_tickets t ${where}`, params.slice(0, -2)
    )

    return paginated(res, tickets, parseInt(count), parseInt(page), parseInt(limit))
  }
)

// ─── STAFF: Assign ticket ─────────────────────────────────────────────────────

supportRouter.post(
  '/:id/assign',
  requireStaff,
  requirePermission('support.*'),
  async (req: Request, res: Response) => {
    const { agentId } = z.object({ agentId: z.string().uuid() }).parse(req.body)

    const agent = await queryOne(
      `SELECT id FROM staff WHERE id = $1 AND is_active = true`, [agentId]
    )
    if (!agent) throw new NotFoundError('Staff agent')

    await query(
      `UPDATE support_tickets
       SET assigned_to = $1, status = 'in_progress', updated_at = NOW()
       WHERE id = $2`,
      [agentId, req.params.id]
    )

    await auditLog({
      actorId: req.staffId, actorType: 'staff',
      action: 'support.ticket_assigned',
      resourceType: 'support_ticket', resourceId: req.params.id,
      newData: { assignedTo: agentId },
    })

    return success(res, { assignedTo: agentId, status: 'in_progress' })
  }
)

// ─── STAFF: Update ticket status ──────────────────────────────────────────────

supportRouter.post(
  '/:id/status',
  requireStaff,
  requirePermission('support.*'),
  async (req: Request, res: Response) => {
    const { status, resolutionNotes } = z.object({
      status:          z.enum(['open', 'in_progress', 'resolved', 'closed', 'escalated']),
      resolutionNotes: z.string().optional(),
    }).parse(req.body)

    await query(
      `UPDATE support_tickets
       SET status = $1,
           resolved_at = CASE WHEN $1 IN ('resolved','closed') THEN NOW() ELSE resolved_at END,
           resolution_notes = COALESCE($2, resolution_notes),
           updated_at = NOW()
       WHERE id = $3`,
      [status, resolutionNotes ?? null, req.params.id]
    )

    await auditLog({
      actorId: req.staffId, actorType: 'staff',
      action: `support.ticket_status.${status}`,
      resourceType: 'support_ticket', resourceId: req.params.id,
    })

    return success(res, { status })
  }
)

// ─── STAFF: Support metrics ───────────────────────────────────────────────────

supportRouter.get(
  '/stats/overview',
  requireStaff,
  requirePermission('support.*'),
  async (req: Request, res: Response) => {
    const stats = await queryOne<Record<string, unknown>>(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'open')                             as open_count,
         COUNT(*) FILTER (WHERE status = 'in_progress')                     as in_progress_count,
         COUNT(*) FILTER (WHERE status IN ('resolved','closed'))             as resolved_count,
         COUNT(*) FILTER (WHERE status = 'escalated')                       as escalated_count,
         COUNT(*) FILTER (WHERE priority = 'critical' AND status = 'open')  as critical_open,
         COUNT(*) FILTER (WHERE assigned_to IS NULL AND status = 'open')    as unassigned_open,
         AVG(EXTRACT(EPOCH FROM (resolved_at - created_at))/3600)
           FILTER (WHERE resolved_at IS NOT NULL)                           as avg_resolution_hours
       FROM support_tickets
       WHERE created_at >= NOW() - INTERVAL '30 days'`
    )

    const byAgent = await query(
      `SELECT s.first_name || ' ' || s.last_name as agent_name,
              COUNT(*) FILTER (WHERE t.status = 'in_progress') as active,
              COUNT(*) FILTER (WHERE t.status IN ('resolved','closed')) as resolved
       FROM staff s
       LEFT JOIN support_tickets t ON t.assigned_to = s.id
         AND t.created_at >= NOW() - INTERVAL '30 days'
       WHERE s.role = 'customer_care'
       GROUP BY s.id, s.first_name, s.last_name
       ORDER BY active DESC`,
      []
    )

    return success(res, { stats, byAgent })
  }
)
