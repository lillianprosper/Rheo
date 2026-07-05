'use client'

/**
 * Rheo Admin — Platform Dashboard
 * Place at: apps/admin/src/app/dashboard/page.tsx  (replaces previous version)
 *
 * CONTRACT (verified against the live API on 2026-07-05, not assumed):
 *   GET {NEXT_PUBLIC_API_URL}/admin/dashboard →
 *   { success: true, data: { approved_drivers, pending_drivers, online_drivers,
 *     active_businesses, pending_businesses, jobs_today, live_jobs,
 *     commission_today_ugx, pending_withdrawals, open_tickets,
 *     driver_kyc_pending, business_kyc_pending } }   — flat keys, numeric strings.
 *
 * Validation guardrail: the payload is parsed through a Zod schema. Every
 * field coerces to a number and falls back to 0 on absence or garbage, so a
 * future contract drift renders as zeros (visibly wrong) instead of crashing
 * (fatally wrong) — and the test suite pins the schema.
 *
 * Security posture: client-side auth gate only gates rendering; the API's
 * requirePermission('analytics.*') is the real authority. 401 → /login via
 * the mockable navigation seam. No data persisted to any browser storage.
 * All rendered values are numbers — zero user-supplied strings on this page,
 * so no XSS surface.
 *
 * Capacity posture: manual refresh only (endpoint runs live aggregates).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { redirectToLogin } from './navigation'

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? ''

// ── Contract schema (source of truth for this page) ──────────────────────────
const kpi = z.coerce.number().catch(0)

const DashboardSchema = z
  .object({
    approved_drivers:     kpi,
    pending_drivers:      kpi,
    online_drivers:       kpi,
    active_businesses:    kpi,
    pending_businesses:   kpi,
    jobs_today:           kpi,
    live_jobs:            kpi,
    commission_today_ugx: kpi,
    pending_withdrawals:  kpi,
    open_tickets:         kpi,
    driver_kyc_pending:   kpi,
    business_kyc_pending: kpi,
  })
  .catch({
    approved_drivers: 0, pending_drivers: 0, online_drivers: 0,
    active_businesses: 0, pending_businesses: 0, jobs_today: 0, live_jobs: 0,
    commission_today_ugx: 0, pending_withdrawals: 0, open_tickets: 0,
    driver_kyc_pending: 0, business_kyc_pending: 0,
  })

type DashboardData = z.infer<typeof DashboardSchema>

const ugx = (v: number): string => `UGX ${v.toLocaleString('en-UG')}`

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
        redirectToLogin()
        return
      }
      if (!res.ok) throw new Error(`API responded with ${res.status}`)
      const body = await res.json()
      setData(DashboardSchema.parse(body?.data ?? {}))
    } catch {
      setError('Could not load dashboard data.')
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

        {loading && !data && (
          <p style={{ color: 'rgba(255,255,255,0.7)' }}>Loading dashboard…</p>
        )}

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

        {data && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem' }}>
            <Kpi label="Drivers online"        value={String(data.online_drivers)} />
            <Kpi label="Drivers approved"      value={String(data.approved_drivers)} />
            <Kpi label="Driver KYC pending"    value={String(data.driver_kyc_pending)} accent={data.driver_kyc_pending > 0} />
            <Kpi label="Active businesses"     value={String(data.active_businesses)} />
            <Kpi label="Businesses pending"    value={String(data.pending_businesses)} accent={data.pending_businesses > 0} />
            <Kpi label="Business KYC pending"  value={String(data.business_kyc_pending)} accent={data.business_kyc_pending > 0} />
            <Kpi label="Jobs today"            value={String(data.jobs_today)} />
            <Kpi label="Live jobs"             value={String(data.live_jobs)} />
            <Kpi label="Commission today"      value={ugx(data.commission_today_ugx)} />
            <Kpi label="Pending withdrawals"   value={String(data.pending_withdrawals)} accent={data.pending_withdrawals > 0} />
            <Kpi label="Open tickets"          value={String(data.open_tickets)} accent={data.open_tickets > 0} />
          </div>
        )}
      </div>
    </div>
  )
}
