'use client'

/**
 * Rheo Admin — Platform Dashboard
 * Place at: apps/admin/src/app/dashboard/page.tsx
 *
 * Data source: GET {NEXT_PUBLIC_API_URL}/admin/dashboard (staff JWT, analytics.* permission)
 *
 * Security posture:
 *  - Renders nothing until a rheo_access cookie exists; missing cookie or any
 *    401 hard-redirects to /login. The API's requirePermission gate is the
 *    real authority — this page holds zero role logic.
 *  - No dashboard data is ever written to localStorage/sessionStorage.
 *  - Audit strings render through React text nodes only (auto-escaped).
 *
 * Capacity posture:
 *  - Manual refresh only. The endpoint runs live aggregate scans, so this
 *    page deliberately does NOT auto-poll (self-DoS guard). Post-launch this
 *    endpoint should be backed by platform_analytics_daily snapshots.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { redirectToLogin } from './navigation'

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? ''

// ── Types (mirror packages/api admin.routes.ts GET /dashboard) ────────────────
interface ActivityEntry {
  action: string
  actor_type: string
  actor_role: string | null
  resource_type: string | null
  created_at: string
}

interface DashboardData {
  jobs:        { queued: unknown; in_transit: unknown; delivered_today: unknown }
  drivers:     { approved: unknown; pending: unknown; online: unknown }
  businesses:  { active: unknown; pending: unknown }
  revenue:     { today: unknown }
  withdrawals: { count: unknown; total: unknown }
  tickets:     { open: unknown; critical: unknown }
  recentActivity: ActivityEntry[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────
/** pg returns bigint counts as strings — normalise defensively, never NaN. */
const num = (v: unknown): number => {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}
const ugx = (v: unknown): string => `UGX ${num(v).toLocaleString('en-UG')}`

const timeAgo = (iso: string): string => {
  const mins = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

/**
 * Contract guard: the UI must never crash on an unexpected API shape.
 * Missing sections coerce to empty objects (num() then yields 0) and a
 * missing/invalid activity list coerces to []. A wrong shape renders as
 * zeros — visibly wrong, safely wrong — instead of a client-side exception.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const normalize = (raw: any): DashboardData => ({
  jobs:        raw?.jobs        ?? {},
  drivers:     raw?.drivers     ?? {},
  businesses:  raw?.businesses  ?? {},
  revenue:     raw?.revenue     ?? {},
  withdrawals: raw?.withdrawals ?? {},
  tickets:     raw?.tickets     ?? {},
  recentActivity: Array.isArray(raw?.recentActivity) ? raw.recentActivity : [],
})

const getAccessToken = (): string | null => {
  const m = document.cookie.match(/(?:^|;\s*)rheo_access=([^;]*)/)
  return m ? decodeURIComponent(m[1]) : null
}

// ── Presentational: single KPI card ──────────────────────────────────────────
function Kpi({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div style={{
      background: '#FFFFFF', borderRadius: '12px', padding: '1.25rem 1.5rem',
      boxShadow: '0 4px 14px rgba(0,0,0,0.12)', minWidth: 0,
    }}>
      <div style={{ fontSize: '0.75rem', fontWeight: 600, letterSpacing: '0.06em',
        textTransform: 'uppercase', color: '#4A6B55', marginBottom: '0.4rem' }}>
        {label}
      </div>
      <div style={{ fontSize: '1.6rem', fontWeight: 700,
        color: accent ? '#B45309' : '#0F2018', fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </div>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function DashboardPage() {
  const [data,    setData]    = useState<DashboardData | null>(null)
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
      const res = await fetch(`${API_BASE}/admin/dashboard`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.status === 401) {
        // Token expired or revoked — the API is the authority; re-authenticate.
        redirectToLogin()
        return
      }
      if (!res.ok) throw new Error(`API responded with ${res.status}`)
      const body = await res.json()
      setData(normalize(body?.data))
    } catch {
      setError('Could not load dashboard data.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // Auth gate runs client-side only (cookie is not HttpOnly by design, for now).
    if (!getAccessToken()) {
      redirectToLogin()
      return
    }
    authorized.current = true
    void load()
  }, [load])

  // Render nothing while unauthenticated — no flash of protected UI.
  if (!authorized.current && !loading && !data && !error) return null

  return (
    <div style={{ minHeight: '100vh', background: '#0F3020', padding: '2rem' }}>
      <div style={{ maxWidth: '1100px', margin: '0 auto' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem' }}>
          <div>
            <div style={{ fontFamily: 'Georgia, serif', fontSize: '1.6rem', fontWeight: 700, color: '#FFFFFF' }}>
              Rheo<span style={{ color: '#F5C842' }}>.</span>
            </div>
            <p style={{ color: 'rgba(255,255,255,0.55)', fontSize: '0.8rem',
              letterSpacing: '0.08em', textTransform: 'uppercase', margin: '0.2rem 0 0' }}>
              Platform Dashboard
            </p>
          </div>
          <button onClick={() => void load()} disabled={loading}
            style={{ padding: '0.6rem 1.2rem', background: '#1D5C38', color: '#FFFFFF',
              border: 'none', borderRadius: '8px', fontSize: '0.85rem', fontWeight: 600,
              cursor: loading ? 'default' : 'pointer', opacity: loading ? 0.7 : 1 }}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        {/* Loading */}
        {loading && !data && (
          <p style={{ color: 'rgba(255,255,255,0.7)' }}>Loading dashboard…</p>
        )}

        {/* Error + Retry */}
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

        {/* KPI grid */}
        {data && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: '1rem', marginBottom: '2rem' }}>
              <Kpi label="Drivers online"        value={String(num(data.drivers.online))} />
              <Kpi label="Drivers pending KYC"   value={String(num(data.drivers.pending))} accent={num(data.drivers.pending) > 0} />
              <Kpi label="Active businesses"     value={String(num(data.businesses.active))} />
              <Kpi label="Jobs queued"           value={String(num(data.jobs.queued))} />
              <Kpi label="Jobs in transit"       value={String(num(data.jobs.in_transit))} />
              <Kpi label="Delivered today"       value={String(num(data.jobs.delivered_today))} />
              <Kpi label="Revenue today"         value={ugx(data.revenue.today)} />
              <Kpi label="Pending withdrawals"   value={`${num(data.withdrawals.count)} · ${ugx(data.withdrawals.total)}`} accent={num(data.withdrawals.count) > 0} />
              <Kpi label="Open tickets"          value={`${num(data.tickets.open)} (${num(data.tickets.critical)} critical)`} accent={num(data.tickets.critical) > 0} />
            </div>

            {/* Recent activity — audit strings rendered as text nodes only */}
            <div style={{ background: '#FFFFFF', borderRadius: '12px', padding: '1.5rem',
              boxShadow: '0 4px 14px rgba(0,0,0,0.12)' }}>
              <h2 style={{ fontSize: '1rem', color: '#0F2018', margin: '0 0 1rem' }}>Recent activity</h2>
              {data.recentActivity.length === 0 ? (
                <p style={{ color: '#4A6B55', fontSize: '0.9rem', margin: 0 }}>No activity yet.</p>
              ) : (
                <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {data.recentActivity.map((entry, i) => (
                    <li key={`${entry.created_at}-${i}`}
                      style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem',
                        padding: '0.6rem 0', borderTop: i === 0 ? 'none' : '1px solid rgba(15,48,32,0.08)',
                        fontSize: '0.875rem', color: '#0F2018' }}>
                      <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                        {entry.action}
                        <span style={{ color: '#4A6B55' }}>
                          {' '}— {entry.actor_type}{entry.actor_role ? ` (${entry.actor_role})` : ''}
                          {entry.resource_type ? ` · ${entry.resource_type}` : ''}
                        </span>
                      </span>
                      <span style={{ color: '#4A6B55', whiteSpace: 'nowrap' }}>{timeAgo(entry.created_at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
