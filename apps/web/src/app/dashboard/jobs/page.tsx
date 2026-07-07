'use client'

/**
 * Rheo Business — Jobs list
 * Place at: apps/web/src/app/dashboard/jobs/page.tsx
 * REPLACES the login-form placeholder previously at this route.
 *
 * CONTRACT — envelope verified on the wire (2026-07-06):
 *   GET {NEXT_PUBLIC_API_URL}/jobs/business?page&limit&status →
 *   { success, data: JobRow[], meta: { total, page, limit, pages, hasNext, hasPrev } }
 *
 *   JobRow shape PINNED against the live wire (first real job,
 *   RHO-20260707-00001, captured 2026-07-07): numeric money fields arrive as
 *   decimal strings ("60000.00"), fare shown is total_fare_ugx (what the
 *   business pays, surge included). Per-field .catch fallbacks are retained
 *   as the drift guard — unknown/renamed fields render as zeros/em-dashes,
 *   never crashes.
 *
 * Security posture:
 *  - Scoping is server-side via the JWT businessId claim. This page sends
 *    ONLY pagination/filter params + the Bearer header — no business
 *    identifier exists in the request (test-asserted).
 *  - Rows contain PII (addresses, contact names). Rendered as React text
 *    nodes only; never persisted to browser storage; never console-logged.
 *  - Query params are client-constrained (page ≥ 1, limit ≤ 50, status from
 *    a fixed enum) and re-validated server-side — belt and suspenders.
 *
 * Capacity posture: server-driven pagination via `meta`; controls disable
 * while a request is in flight so rapid clicks can't stack requests.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { redirectToLogin } from '../navigation'

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? ''
const PAGE_LIMIT = 20 // hard client cap well under the 50 ceiling

// Status values from the jobs schema — fixed enum, not free text
const STATUSES = ['', 'queued', 'assigned', 'in_transit', 'delivered', 'failed', 'cancelled'] as const
type StatusFilter = (typeof STATUSES)[number]

// ── Tolerant row schema (draft — pin against the wire after first job) ──────
const JobRowSchema = z
  .object({
    id:               z.string().catch(''),
    job_ref:          z.string().catch('—'),
    status:           z.string().catch('unknown'),
    pickup_address:   z.string().catch('—'),
    delivery_address: z.string().catch('—'),
    base_fare_ugx:    z.coerce.number().catch(0),
    total_fare_ugx:   z.coerce.number().catch(0), // wire-verified: surge-inclusive amount the business pays
    created_at:       z.string().catch(''),
  })
  .passthrough()

const MetaSchema = z
  .object({
    total:   z.coerce.number().catch(0),
    page:    z.coerce.number().catch(1),
    limit:   z.coerce.number().catch(PAGE_LIMIT),
    pages:   z.coerce.number().catch(0),
    hasNext: z.boolean().catch(false),
    hasPrev: z.boolean().catch(false),
  })
  .catch({ total: 0, page: 1, limit: PAGE_LIMIT, pages: 0, hasNext: false, hasPrev: false })

type JobRow = z.infer<typeof JobRowSchema>
type Meta   = z.infer<typeof MetaSchema>

const ugx = (v: number): string => `UGX ${v.toLocaleString('en-UG')}`

const getAccessToken = (): string | null => {
  const m = document.cookie.match(/(?:^|;\s*)rheo_access=([^;]*)/)
  return m ? decodeURIComponent(m[1]) : null
}

const STATUS_COLORS: Record<string, string> = {
  queued: '#B45309', assigned: '#1D4ED8', in_transit: '#7C3AED',
  delivered: '#15803D', failed: '#B91C1C', cancelled: '#6B7280',
}

function StatusBadge({ status }: { status: string }) {
  const color = STATUS_COLORS[status] ?? '#6B7280'
  return (
    <span style={{ color, border: `1px solid ${color}`, borderRadius: '999px',
      padding: '0.1rem 0.6rem', fontSize: '0.72rem', fontWeight: 600,
      textTransform: 'capitalize', whiteSpace: 'nowrap' }}>
      {status.replace('_', ' ')}
    </span>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function JobsPage() {
  const [rows,    setRows]    = useState<JobRow[] | null>(null)
  const [meta,    setMeta]    = useState<Meta>({ total: 0, page: 1, limit: PAGE_LIMIT, pages: 0, hasNext: false, hasPrev: false })
  const [status,  setStatus]  = useState<StatusFilter>('')
  const [page,    setPage]    = useState<number>(1)
  const [error,   setError]   = useState<string>('')
  const [loading, setLoading] = useState<boolean>(true)
  const authorized = useRef<boolean>(false)

  const load = useCallback(async (pageArg: number, statusArg: StatusFilter) => {
    setLoading(true)
    setError('')
    try {
      const token = getAccessToken()
      if (!token) {
        redirectToLogin()
        return
      }
      // Client-side constraint of user-controlled params (server re-validates)
      const params = new URLSearchParams({
        page:  String(Math.max(1, Math.floor(pageArg))),
        limit: String(PAGE_LIMIT),
      })
      if (statusArg && (STATUSES as readonly string[]).includes(statusArg)) {
        params.set('status', statusArg)
      }
      const res = await fetch(`${API_BASE}/jobs/business?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.status === 401) {
        redirectToLogin()
        return
      }
      if (!res.ok) throw new Error(`API responded with ${res.status}`)
      const body = await res.json()
      const list = Array.isArray(body?.data) ? body.data : []
      setRows(list.map((r: unknown) => JobRowSchema.parse(r ?? {})))
      setMeta(MetaSchema.parse(body?.meta ?? {}))
    } catch {
      setError('Could not load your jobs.')
      setRows((prev) => prev ?? []) // keep prior rows on transient failure
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!getAccessToken()) {
      redirectToLogin()
      return
    }
    authorized.current = true
    void load(page, status)
  }, [load, page, status])

  if (!authorized.current && !loading && rows === null && !error) return null

  return (
    <div style={{ padding: '2rem', maxWidth: '1100px' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem', gap: '1rem', flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontSize: '1.4rem', margin: 0, color: 'var(--forest-dark, #0F2018)' }}>Jobs</h1>
          <p style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', color: 'var(--ink-muted, #6B7280)' }}>
            {meta.total} total
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <label htmlFor="status-filter" style={{ fontSize: '0.8rem', color: 'var(--ink-muted, #6B7280)' }}>Status</label>
          <select id="status-filter" value={status} disabled={loading}
            onChange={(e) => { setPage(1); setStatus(e.target.value as StatusFilter) }}
            style={{ padding: '0.45rem 0.6rem', borderRadius: '8px', border: '1px solid #D1D5DB', fontSize: '0.85rem' }}>
            <option value="">All statuses</option>
            {STATUSES.filter(Boolean).map((s) => (
              <option key={s} value={s}>{s.replace('_', ' ')}</option>
            ))}
          </select>
          <a href="/dashboard/jobs/new" className="btn btn-primary"
            style={{ padding: '0.55rem 1.1rem', textDecoration: 'none' }}>
            New job
          </a>
        </div>
      </div>

      {loading && rows === null && <p style={{ color: 'var(--ink-muted, #6B7280)' }}>Loading jobs…</p>}

      {error && (
        <div style={{ background: '#FEE2E2', color: '#B91C1C', padding: '1rem 1.25rem',
          borderRadius: '8px', marginBottom: '1.25rem', borderLeft: '3px solid #DC2626',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
          <span>{error}</span>
          <button onClick={() => void load(page, status)}
            style={{ padding: '0.45rem 1rem', background: '#B91C1C', color: '#FFFFFF',
              border: 'none', borderRadius: '6px', fontWeight: 600, cursor: 'pointer' }}>
            Retry
          </button>
        </div>
      )}

      {/* Empty state */}
      {rows !== null && rows.length === 0 && !error && (
        <div className="card">
          <div className="card-body" style={{ padding: '2.5rem', textAlign: 'center' }}>
            <p style={{ margin: 0, fontWeight: 600, color: 'var(--forest-dark, #0F2018)' }}>No jobs yet</p>
            <p style={{ margin: '0.5rem 0 1.25rem', fontSize: '0.875rem', color: 'var(--ink-muted, #6B7280)' }}>
              Create your first delivery job and it will appear here.
            </p>
            <a href="/dashboard/jobs/new" className="btn btn-primary"
              style={{ padding: '0.6rem 1.2rem', textDecoration: 'none' }}>
              Create your first job
            </a>
          </div>
        </div>
      )}

      {/* Table */}
      {rows !== null && rows.length > 0 && (
        <div className="card">
          <div className="card-body" style={{ padding: 0, overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--ink-muted, #6B7280)' }}>
                  {['Ref', 'Status', 'Pickup', 'Delivery', 'Fare', 'Created'].map((h) => (
                    <th key={h} style={{ padding: '0.75rem 1rem', borderBottom: '1px solid #E5E7EB',
                      fontSize: '0.72rem', letterSpacing: '0.06em', textTransform: 'uppercase' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((j, i) => (
                  <tr key={j.id || i}>
                    <td style={{ padding: '0.75rem 1rem', fontWeight: 600, whiteSpace: 'nowrap' }}>{j.job_ref}</td>
                    <td style={{ padding: '0.75rem 1rem' }}><StatusBadge status={j.status} /></td>
                    <td style={{ padding: '0.75rem 1rem', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{j.pickup_address}</td>
                    <td style={{ padding: '0.75rem 1rem', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{j.delivery_address}</td>
                    <td style={{ padding: '0.75rem 1rem', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{ugx(j.total_fare_ugx)}</td>
                    <td style={{ padding: '0.75rem 1rem', whiteSpace: 'nowrap', color: 'var(--ink-muted, #6B7280)' }}>
                      {j.created_at ? new Date(j.created_at).toLocaleDateString('en-UG') : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Pagination — server-driven via meta; disabled while in flight */}
      {rows !== null && rows.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '0.75rem', marginTop: '1rem' }}>
          <span style={{ fontSize: '0.8rem', color: 'var(--ink-muted, #6B7280)' }}>
            Page {meta.page} of {Math.max(1, meta.pages)}
          </span>
          <button onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={loading || !meta.hasPrev}
            style={{ padding: '0.45rem 0.9rem', borderRadius: '8px', border: '1px solid #D1D5DB',
              background: '#FFFFFF', cursor: loading || !meta.hasPrev ? 'default' : 'pointer',
              opacity: loading || !meta.hasPrev ? 0.5 : 1 }}>
            Previous
          </button>
          <button onClick={() => setPage((p) => p + 1)}
            disabled={loading || !meta.hasNext}
            style={{ padding: '0.45rem 0.9rem', borderRadius: '8px', border: '1px solid #D1D5DB',
              background: '#FFFFFF', cursor: loading || !meta.hasNext ? 'default' : 'pointer',
              opacity: loading || !meta.hasNext ? 0.5 : 1 }}>
            Next
          </button>
        </div>
      )}
    </div>
  )
}
