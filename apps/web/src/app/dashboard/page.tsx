'use client'

/**
 * Rheo Business — Overview page
 * Place at: apps/web/src/app/dashboard/page.tsx
 * REPLACES the login-form placeholder that previously occupied this route.
 *
 * CONTRACT (verified against the live API on 2026-07-06, captured from the
 * wire — not from docs):
 *   GET {NEXT_PUBLIC_API_URL}/analytics/business/summary →
 *   { success, data: {
 *       summary: { jobs_total, jobs_delivered, jobs_failed, jobs_cancelled,
 *                  total_spend_ugx, avg_delivery_mins, unique_drivers,   // numeric strings
 *                  successRate },                                        // plain number
 *       today:   { queued, assigned, in_transit, delivered_today },      // numeric strings
 *       trend:   [] } }                                                  // shape unknown until seeded — not rendered yet
 *
 * Security posture:
 *  - Scoping is server-side: the API derives businessId from the JWT claim;
 *    this page sends ONLY the Bearer header — no business identifier exists
 *    in the request to tamper with.
 *  - No cookie / 401 → hard redirect to /login?from=/dashboard via the
 *    mockable navigation seam. Nothing persisted to browser storage.
 *  - All rendered values are numbers — no user-supplied strings, no XSS surface.
 *
 * Capacity posture: manual refresh only (endpoint aggregates live).
 * `trend` is schema-tolerated but not rendered until its row shape is
 * captured from a seeded job (registered follow-up).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { redirectToLogin } from './navigation'

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? ''

// ── Contract schema (built from the captured payload) ────────────────────────
const kpi = z.coerce.number().catch(0)

const SummarySchema = z
  .object({
    summary: z
      .object({
        jobs_total:        kpi,
        jobs_delivered:    kpi,
        jobs_failed:       kpi,
        jobs_cancelled:    kpi,
        total_spend_ugx:   kpi,
        avg_delivery_mins: kpi,
        unique_drivers:    kpi,
        successRate:       kpi,
      })
      .catch({
        jobs_total: 0, jobs_delivered: 0, jobs_failed: 0, jobs_cancelled: 0,
        total_spend_ugx: 0, avg_delivery_mins: 0, unique_drivers: 0, successRate: 0,
      }),
    today: z
      .object({
        queued:          kpi,
        assigned:        kpi,
        in_transit:      kpi,
        delivered_today: kpi,
      })
      .catch({ queued: 0, assigned: 0, in_transit: 0, delivered_today: 0 }),
    trend: z.array(z.unknown()).catch([]),
  })
  .catch({
    summary: {
      jobs_total: 0, jobs_delivered: 0, jobs_failed: 0, jobs_cancelled: 0,
      total_spend_ugx: 0, avg_delivery_mins: 0, unique_drivers: 0, successRate: 0,
    },
    today: { queued: 0, assigned: 0, in_transit: 0, delivered_today: 0 },
    trend: [],
  })

type SummaryData = z.infer<typeof SummarySchema>

const ugx = (v: number): string => `UGX ${v.toLocaleString('en-UG')}`

const getAccessToken = (): string | null => {
  const m = document.cookie.match(/(?:^|;\s*)rheo_access=([^;]*)/)
  return m ? decodeURIComponent(m[1]) : null
}

// ── Presentational: single KPI card ──────────────────────────────────────────
function Kpi({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="card" style={{ minWidth: 0 }}>
      <div className="card-body" style={{ padding: '1.1rem 1.4rem' }}>
        <div style={{ fontSize: '0.72rem', fontWeight: 600, letterSpacing: '0.06em',
          textTransform: 'uppercase', color: 'var(--ink-muted, #6B7280)', marginBottom: '0.35rem' }}>
          {label}
        </div>
        <div style={{ fontSize: '1.5rem', fontWeight: 700, fontVariantNumeric: 'tabular-nums',
          color: accent ? '#B45309' : 'var(--forest-dark, #0F2018)' }}>
          {value}
        </div>
      </div>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function OverviewPage() {
  const [data,    setData]    = useState<SummaryData | null>(null)
  const [error,   setError]   = useState<string>('')
  const [loading, setLoading] = useState<boolean>(true)
  const authorized = useRef<boolean>(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const token = getAccessToken()
      if (!token) {
        redirectToLogin()
        return
      }
      const res = await fetch(`${API_BASE}/analytics/business/summary`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.status === 401) {
        redirectToLogin()
        return
      }
      if (!res.ok) throw new Error(`API responded with ${res.status}`)
      const body = await res.json()
      setData(SummarySchema.parse(body?.data ?? {}))
    } catch {
      setError('Could not load your overview.')
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
    void load()
  }, [load])

  if (!authorized.current && !loading && !data && !error) return null

  const s = data?.summary
  const t = data?.today

  return (
    <div style={{ padding: '2rem', maxWidth: '1100px' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ fontSize: '1.4rem', margin: 0, color: 'var(--forest-dark, #0F2018)' }}>Overview</h1>
          <p style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', color: 'var(--ink-muted, #6B7280)' }}>
            Your delivery activity at a glance
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => void load()} disabled={loading}
          style={{ padding: '0.55rem 1.1rem', opacity: loading ? 0.7 : 1, cursor: loading ? 'default' : 'pointer' }}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {loading && !data && <p style={{ color: 'var(--ink-muted, #6B7280)' }}>Loading overview…</p>}

      {error && (
        <div style={{ background: '#FEE2E2', color: '#B91C1C', padding: '1rem 1.25rem',
          borderRadius: '8px', marginBottom: '1.5rem', borderLeft: '3px solid #DC2626',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
          <span>{error}</span>
          <button onClick={() => void load()}
            style={{ padding: '0.45rem 1rem', background: '#B91C1C', color: '#FFFFFF',
              border: 'none', borderRadius: '6px', fontWeight: 600, cursor: 'pointer' }}>
            Retry
          </button>
        </div>
      )}

      {data && s && t && (
        <>
          {/* Today */}
          <h2 style={{ fontSize: '0.8rem', letterSpacing: '0.08em', textTransform: 'uppercase',
            color: 'var(--ink-muted, #6B7280)', margin: '0 0 0.75rem' }}>Today</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: '1rem', marginBottom: '2rem' }}>
            <Kpi label="Queued"          value={String(t.queued)} accent={t.queued > 0} />
            <Kpi label="Assigned"        value={String(t.assigned)} />
            <Kpi label="In transit"      value={String(t.in_transit)} accent={t.in_transit > 0} />
            <Kpi label="Delivered today" value={String(t.delivered_today)} />
          </div>

          {/* All-time */}
          <h2 style={{ fontSize: '0.8rem', letterSpacing: '0.08em', textTransform: 'uppercase',
            color: 'var(--ink-muted, #6B7280)', margin: '0 0 0.75rem' }}>All time</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem' }}>
            <Kpi label="Total jobs"        value={String(s.jobs_total)} />
            <Kpi label="Delivered"         value={String(s.jobs_delivered)} />
            <Kpi label="Failed"            value={String(s.jobs_failed)} accent={s.jobs_failed > 0} />
            <Kpi label="Cancelled"         value={String(s.jobs_cancelled)} />
            <Kpi label="Total spend"       value={ugx(s.total_spend_ugx)} />
            <Kpi label="Avg delivery time" value={`${s.avg_delivery_mins} min`} />
            <Kpi label="Drivers used"      value={String(s.unique_drivers)} />
            <Kpi label="Success rate"      value={`${s.successRate}%`} />
          </div>
        </>
      )}
    </div>
  )
}
