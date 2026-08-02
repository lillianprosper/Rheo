'use client'
/**
 * Rheo Admin — KYC Review Queue (drivers)
 * Place at: apps/admin/src/app/dashboard/kyc/page.tsx
 *
 * CONTRACT (verified against admin.routes.ts, not assumed):
 *   GET  {NEXT_PUBLIC_API_URL}/admin/kyc/queue?type=driver →
 *     { success: true, data: { type: 'driver', queue: [ {
 *         id, first_name, last_name, phone, email, status, kyc_status,
 *         vehicle_type, plate_number, created_at, doc_count } ] } }
 *   POST {NEXT_PUBLIC_API_URL}/admin/kyc/driver/:id/review
 *     body { action: 'approve' | 'reject', notes? } →
 *     { success: true, data: { kycStatus, documents } }
 *   Approving a driver flips BOTH kyc_status → 'approved' AND the account
 *   status → 'approved' in one call, so one click activates the driver.
 *
 * Validation guardrail: each queue row is parsed through a Zod schema with
 * per-field .catch() fallbacks, so a future contract drift renders as an
 * obviously-empty/odd row (visibly wrong) rather than crashing (fatally
 * wrong). The test suite pins the schema.
 *
 * Security posture: client-side gate only gates rendering; the API's
 * requirePermission('drivers.approve') (or equivalent) is the real
 * authority. 401 → /login via the mockable navigation seam. No browser
 * storage. Driver-supplied strings (name, plate) are rendered as React
 * text nodes — no dangerouslySetInnerHTML — so no XSS surface.
 */
import { useCallback, useEffect, useState } from 'react'
import { z } from 'zod'
import { redirectToLogin } from '../navigation'

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? ''

// ── Contract schema (source of truth for this page) ──────────────────────────
const str = z.coerce.string().catch('')
const num = z.coerce.number().catch(0)

const DriverRowSchema = z
  .object({
    id:            z.string().catch(''),
    first_name:    str,
    last_name:     str,
    phone:         str,
    email:         str,
    status:        str,
    kyc_status:    str,
    vehicle_type:  str,
    plate_number:  str,
    created_at:    str,
    doc_count:     num,
  })
  .catch({
    id: '', first_name: '', last_name: '', phone: '', email: '',
    status: '', kyc_status: '', vehicle_type: '', plate_number: '',
    created_at: '', doc_count: 0,
  })

const QueueSchema = z
  .object({
    type:  z.string().catch('driver'),
    queue: z.array(DriverRowSchema).catch([]),
  })
  .catch({ type: 'driver', queue: [] })

type DriverRow = z.infer<typeof DriverRowSchema>

// ── Helpers ──────────────────────────────────────────────────────────────────
const getAccessToken = (): string | null => {
  const m = document.cookie.match(/(?:^|;\s*)rheo_access=([^;]*)/)
  return m ? decodeURIComponent(m[1]) : null
}

function waitedFor(iso: string): string {
  if (!iso) return '—'
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return '—'
  const mins = Math.floor((Date.now() - then) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h`
  return `${Math.floor(hrs / 24)}d`
}

const fullName = (d: DriverRow): string =>
  `${d.first_name} ${d.last_name}`.trim() || '(no name)'

// ── Page ──────────────────────────────────────────────────────────────────────
export default function KycQueuePage() {
  const [rows,    setRows]    = useState<DriverRow[]>([])
  const [error,   setError]   = useState<string>('')
  const [loading, setLoading] = useState<boolean>(true)

  // Per-driver UI state: which row is submitting, and reject-notes drafts
  const [busyId,     setBusyId]     = useState<string>('')
  const [rejectId,   setRejectId]   = useState<string>('')  // row with notes box open
  const [rejectNote, setRejectNote] = useState<string>('')
  const [banner,     setBanner]     = useState<string>('')  // success feedback

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const token = getAccessToken()
      if (!token) { redirectToLogin(); return }

      const res = await fetch(`${API_BASE}/admin/kyc/queue?type=driver`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.status === 401) { redirectToLogin(); return }
      if (!res.ok) throw new Error(`API responded with ${res.status}`)

      const json = await res.json()
      const parsed = QueueSchema.parse(json?.data ?? {})
      setRows(parsed.queue)
    } catch {
      setError('Could not load the review queue. Please retry.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const review = useCallback(
    async (id: string, action: 'approve' | 'reject', notes?: string) => {
      setBusyId(id)
      setError('')
      setBanner('')
      try {
        const token = getAccessToken()
        if (!token) { redirectToLogin(); return }

        const res = await fetch(`${API_BASE}/admin/kyc/driver/${id}/review`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(notes ? { action, notes } : { action }),
        })
        if (res.status === 401) { redirectToLogin(); return }
        if (!res.ok) throw new Error(`API responded with ${res.status}`)

        // Success: drop the row from the queue and confirm.
        setRows((prev) => prev.filter((d) => d.id !== id))
        setRejectId('')
        setRejectNote('')
        setBanner(action === 'approve' ? 'Driver approved and activated.' : 'Driver rejected.')
      } catch {
        setError(`Could not ${action} this driver. Please retry.`)
      } finally {
        setBusyId('')
      }
    },
    []
  )

  return (
    <div style={{ minHeight: '100vh', background: '#0F3020', padding: '2rem' }}>
      <div style={{ maxWidth: 1080, margin: '0 auto' }}>
        {/* Header */}
        <div style={{ marginBottom: '1.5rem' }}>
          <h1 style={{
            fontFamily: 'Georgia, serif', fontSize: '1.8rem', fontWeight: 700,
            color: '#FFFFFF', margin: 0,
          }}>
            Driver KYC Review
          </h1>
          <p style={{ color: 'rgba(255,255,255,0.6)', fontSize: '0.9rem', margin: '0.3rem 0 0' }}>
            Pending drivers awaiting verification. Approving activates the account immediately.
          </p>
        </div>

        {banner && (
          <div style={{
            background: '#EEF7F0', color: '#1D5C38', borderLeft: '3px solid #1D5C38',
            padding: '0.75rem 1rem', borderRadius: 8, marginBottom: '1rem', fontSize: '0.85rem',
          }}>
            {banner}
          </div>
        )}
        {error && (
          <div style={{
            background: '#FFEBEE', color: '#B91C1C', borderLeft: '3px solid #E53935',
            padding: '0.75rem 1rem', borderRadius: 8, marginBottom: '1rem', fontSize: '0.85rem',
          }}>
            {error}
          </div>
        )}

        {loading ? (
          <div style={{ color: 'rgba(255,255,255,0.7)', padding: '3rem', textAlign: 'center' }}>
            Loading review queue…
          </div>
        ) : rows.length === 0 ? (
          <div style={{
            background: '#FFFFFF', borderRadius: 12, padding: '3rem 2rem', textAlign: 'center',
            boxShadow: '0 4px 14px rgba(0,0,0,0.12)',
          }}>
            <div style={{ fontSize: '2rem', marginBottom: 10 }}>✅</div>
            <div style={{ fontSize: '1.05rem', fontWeight: 600, color: '#0F2018', marginBottom: 4 }}>
              Queue is clear
            </div>
            <div style={{ color: '#4A6B55', fontSize: '0.85rem' }}>
              No drivers are waiting for review right now.
            </div>
          </div>
        ) : (
          <div style={{
            background: '#FFFFFF', borderRadius: 12, overflow: 'hidden',
            boxShadow: '0 4px 14px rgba(0,0,0,0.12)',
          }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#EEF7F0', textAlign: 'left' }}>
                  <th style={th}>Driver</th>
                  <th style={th}>Contact</th>
                  <th style={th}>Vehicle</th>
                  <th style={{ ...th, textAlign: 'center' }}>Docs</th>
                  <th style={{ ...th, textAlign: 'center' }}>Waiting</th>
                  <th style={{ ...th, textAlign: 'right' }}>Decision</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => (
                  <tr key={d.id} style={{ borderTop: '1px solid rgba(29,92,56,0.12)' }}>
                    <td style={td}>
                      <div style={{ fontWeight: 600, color: '#0F2018', fontSize: '0.88rem' }}>{fullName(d)}</div>
                      <div style={{ color: '#7A9A82', fontSize: '0.72rem' }}>{d.kyc_status || 'submitted'}</div>
                    </td>
                    <td style={td}>
                      <div style={{ fontSize: '0.82rem', color: '#0F2018' }}>{d.phone || '—'}</div>
                      <div style={{ fontSize: '0.72rem', color: '#7A9A82' }}>{d.email || '—'}</div>
                    </td>
                    <td style={td}>
                      <div style={{ fontSize: '0.82rem', color: '#0F2018' }}>{d.vehicle_type || '—'}</div>
                      <div style={{ fontSize: '0.72rem', color: '#7A9A82' }}>{d.plate_number || 'no plate'}</div>
                    </td>
                    <td style={{ ...td, textAlign: 'center' }}>
                      <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: '0.85rem' }}>{d.doc_count}</span>
                    </td>
                    <td style={{ ...td, textAlign: 'center', color: '#7A9A82', fontSize: '0.8rem' }}>
                      {waitedFor(d.created_at)}
                    </td>
                    <td style={{ ...td, textAlign: 'right' }}>
                      {rejectId === d.id ? (
                        <div style={{ display: 'inline-flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
                          <input
                            aria-label={`Reason for rejecting ${fullName(d)}`}
                            placeholder="Reason (optional)"
                            value={rejectNote}
                            onChange={(e) => setRejectNote(e.target.value)}
                            style={{
                              padding: '0.4rem 0.6rem', border: '1.5px solid rgba(29,92,56,0.2)',
                              borderRadius: 8, fontSize: '0.8rem', width: 200,
                            }}
                          />
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button
                              onClick={() => { setRejectId(''); setRejectNote('') }}
                              disabled={busyId === d.id}
                              style={btnGhost}
                            >
                              Cancel
                            </button>
                            <button
                              onClick={() => void review(d.id, 'reject', rejectNote.trim() || undefined)}
                              disabled={busyId === d.id}
                              style={btnReject}
                            >
                              {busyId === d.id ? '…' : 'Confirm reject'}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div style={{ display: 'inline-flex', gap: 8 }}>
                          <button
                            onClick={() => { setRejectId(d.id); setRejectNote('') }}
                            disabled={busyId === d.id}
                            style={btnGhost}
                          >
                            Reject
                          </button>
                          <button
                            onClick={() => void review(d.id, 'approve')}
                            disabled={busyId === d.id}
                            style={btnApprove}
                          >
                            {busyId === d.id ? '…' : 'Approve'}
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Inline styles (match dashboard/page.tsx conventions) ─────────────────────
const th: React.CSSProperties = {
  padding: '0.7rem 1rem', fontSize: '0.7rem', fontWeight: 600,
  letterSpacing: '0.05em', textTransform: 'uppercase', color: '#4A6B55',
}
const td: React.CSSProperties = { padding: '0.8rem 1rem', verticalAlign: 'middle' }

const btnBase: React.CSSProperties = {
  padding: '0.45rem 0.9rem', borderRadius: 50, border: 'none',
  fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer',
}
const btnApprove: React.CSSProperties = { ...btnBase, background: '#1D5C38', color: '#FFFFFF' }
const btnReject:  React.CSSProperties = { ...btnBase, background: '#E53935', color: '#FFFFFF' }
const btnGhost:   React.CSSProperties = { ...btnBase, background: 'transparent', color: '#4A6B55', border: '1.5px solid rgba(29,92,56,0.2)' }

