'use client'

/**
 * Rheo Business — Analytics
 * Place at: apps/web/src/app/dashboard/analytics/page.tsx
 * REPLACES the login-form placeholder previously at this route.
 *
 * CONTRACTS — all three captured from the live wire (2026-07-09):
 *   GET /analytics/business/summary    → { summary, today, trend[] }
 *       trend row: { date: ISO, jobs_total: number, jobs_delivered: number,
 *                    total_spend_ugx: "0.00" }   ← wire-verified incl. cron output
 *   GET /analytics/business/live-queue → [ active job rows, driver fields null
 *                                          until assigned ]
 *   GET /analytics/business/billing    → { subscription|null, invoices[],
 *                                          jobsUsedThisMonth }
 *
 * Notes from the wire: numeric strings arrive in awkward forms
 * ("0.00000000000000000000") — the kpi coercer normalises all of them.
 * Driver contact fields appear only once a driver is assigned; showing the
 * assigned driver's phone to the paying business is intended disclosure.
 *
 * Capacity: manual refresh only; trend rendered with dependency-free CSS
 * bars (no chart library — smaller bundle for mobile-data users) and capped
 * at the most recent 30 rows client-side.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { redirectToLogin } from '../navigation'

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? ''
const TREND_CAP = 30

// ── Schemas (from captured payloads) ─────────────────────────────────────────
const kpi = z.coerce.number().catch(0)
const str = z.string().nullable().catch(null)

const SummarySchema = z.object({
  summary: z.object({
    jobs_total: kpi, jobs_delivered: kpi, jobs_failed: kpi, jobs_cancelled: kpi,
    total_spend_ugx: kpi, avg_delivery_mins: kpi, unique_drivers: kpi, successRate: kpi,
  }).catch({ jobs_total: 0, jobs_delivered: 0, jobs_failed: 0, jobs_cancelled: 0,
    total_spend_ugx: 0, avg_delivery_mins: 0, unique_drivers: 0, successRate: 0 }),
  trend: z.array(z.object({
    date: z.string().catch(''),
    jobs_total: kpi,
    jobs_delivered: kpi,
    total_spend_ugx: kpi,
  }).catch({ date: '', jobs_total: 0, jobs_delivered: 0, total_spend_ugx: 0 })).catch([]),
}).catch({
  summary: { jobs_total: 0, jobs_delivered: 0, jobs_failed: 0, jobs_cancelled: 0,
    total_spend_ugx: 0, avg_delivery_mins: 0, unique_drivers: 0, successRate: 0 },
  trend: [],
})

const LiveJobSchema = z.object({
  id: z.string().catch(''),
  job_ref: z.string().catch('—'),
  status: z.string().catch('unknown'),
  pickup_address: z.string().catch('—'),
  delivery_address: z.string().catch('—'),
  total_fare_ugx: kpi,
  driver_first_name: str,
  driver_last_name: str,
  driver_phone: str,
}).passthrough()

const BillingSchema = z.object({
  subscription: z.unknown().nullable().catch(null),
  invoices: z.array(z.unknown()).catch([]),
  jobsUsedThisMonth: kpi,
}).catch({ subscription: null, invoices: [], jobsUsedThisMonth: 0 })

type SummaryData = z.infer<typeof SummarySchema>
type LiveJob     = z.infer<typeof LiveJobSchema>
type Billing     = z.infer<typeof BillingSchema>

const ugx = (v: number): string => `UGX ${v.toLocaleString('en-UG')}`
const day = (iso: string): string => {
  const d = new Date(iso)
  // Pinned to Africa/Kampala: snapshot dates are business-day facts in EAT.
  // Without this, a browser in another timezone shifts "Jul 7" to "Jul 6".
  return isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString('en-UG', { month: 'short', day: 'numeric', timeZone: 'Africa/Kampala' })
}

const getAccessToken = (): string | null => {
  const m = document.cookie.match(/(?:^|;\s*)rheo_access=([^;]*)/)
  return m ? decodeURIComponent(m[1]) : null
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="card" style={{ minWidth: 0 }}>
      <div className="card-body" style={{ padding: '1rem 1.25rem' }}>
        <div style={{ fontSize: '0.7rem', fontWeight: 600, letterSpacing: '0.06em',
          textTransform: 'uppercase', color: 'var(--ink-muted, #6B7280)', marginBottom: '0.3rem' }}>{label}</div>
        <div style={{ fontSize: '1.35rem', fontWeight: 700, fontVariantNumeric: 'tabular-nums',
          color: 'var(--forest-dark, #0F2018)' }}>{value}</div>
      </div>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function AnalyticsPage() {
  const [data,    setData]    = useState<SummaryData | null>(null)
  const [queue,   setQueue]   = useState<LiveJob[]>([])
  const [billing, setBilling] = useState<Billing | null>(null)
  const [error,   setError]   = useState<string>('')
  const [loading, setLoading] = useState<boolean>(true)
  const authorized = useRef<boolean>(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const token = getAccessToken()
      if (!token) { redirectToLogin(); return }
      const headers = { Authorization: `Bearer ${token}` }
      const [sRes, qRes, bRes] = await Promise.all([
        fetch(`${API_BASE}/analytics/business/summary`,    { headers }),
        fetch(`${API_BASE}/analytics/business/live-queue`, { headers }),
        fetch(`${API_BASE}/analytics/business/billing`,    { headers }),
      ])
      if ([sRes, qRes, bRes].some((r) => r.status === 401)) { redirectToLogin(); return }
      if (![sRes, qRes, bRes].every((r) => r.ok)) throw new Error('API error')
      const [sBody, qBody, bBody] = await Promise.all([sRes.json(), qRes.json(), bRes.json()])
      setData(SummarySchema.parse(sBody?.data ?? {}))
      const list = Array.isArray(qBody?.data) ? qBody.data : []
      setQueue(list.map((j: unknown) => LiveJobSchema.parse(j ?? {})))
      setBilling(BillingSchema.parse(bBody?.data ?? {}))
    } catch {
      setError('Could not load analytics.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!getAccessToken()) { redirectToLogin(); return }
    authorized.current = true
    void load()
  }, [load])

  if (!authorized.current && !loading && !data && !error) return null

  const s = data?.summary
  const trend = (data?.trend ?? []).slice(-TREND_CAP)
  const maxJobs = Math.max(1, ...trend.map((t) => t.jobs_total))

  return (
    <div style={{ padding: '2rem', maxWidth: '1100px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ fontSize: '1.4rem', margin: 0, color: 'var(--forest-dark, #0F2018)' }}>Analytics</h1>
          <p style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', color: 'var(--ink-muted, #6B7280)' }}>
            Delivery performance and billing · totals update nightly
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => void load()} disabled={loading}
          style={{ padding: '0.55rem 1.1rem', opacity: loading ? 0.7 : 1, cursor: loading ? 'default' : 'pointer' }}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {loading && !data && <p style={{ color: 'var(--ink-muted, #6B7280)' }}>Loading analytics…</p>}

      {error && (
        <div style={{ background: '#FEE2E2', color: '#B91C1C', padding: '1rem 1.25rem',
          borderRadius: '8px', marginBottom: '1.25rem', borderLeft: '3px solid #DC2626',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
          <span>{error}</span>
          <button onClick={() => void load()}
            style={{ padding: '0.45rem 1rem', background: '#B91C1C', color: '#FFFFFF',
              border: 'none', borderRadius: '6px', fontWeight: 600, cursor: 'pointer' }}>
            Retry
          </button>
        </div>
      )}

      {data && s && (
        <>
          {/* All-time KPIs */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: '1rem', marginBottom: '2rem' }}>
            <Kpi label="Total jobs"    value={String(s.jobs_total)} />
            <Kpi label="Delivered"     value={String(s.jobs_delivered)} />
            <Kpi label="Total spend"   value={ugx(s.total_spend_ugx)} />
            <Kpi label="Avg delivery"  value={`${Math.round(s.avg_delivery_mins)} min`} />
            <Kpi label="Success rate"  value={`${s.successRate}%`} />
          </div>

          {/* Daily trend — dependency-free bars */}
          <div className="card" style={{ marginBottom: '1.5rem' }}>
            <div className="card-body" style={{ padding: '1.5rem' }}>
              <h2 style={{ fontSize: '1rem', margin: '0 0 1rem' }}>Daily jobs</h2>
              {trend.length === 0 ? (
                <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--ink-muted, #6B7280)' }}>
                  No history yet — daily totals appear after your first full day.
                </p>
              ) : (
                <div>
                  {trend.map((t, i) => (
                    <div key={`${t.date}-${i}`} style={{ display: 'grid',
                      gridTemplateColumns: '64px 1fr 120px', alignItems: 'center',
                      gap: '0.75rem', padding: '0.3rem 0', fontSize: '0.82rem' }}>
                      <span style={{ color: 'var(--ink-muted, #6B7280)', whiteSpace: 'nowrap' }}>{day(t.date)}</span>
                      <div style={{ background: 'rgba(15,48,32,0.07)', borderRadius: '999px', height: '10px' }}>
                        <div style={{ width: `${(t.jobs_total / maxJobs) * 100}%`, minWidth: t.jobs_total > 0 ? '10px' : 0,
                          background: 'var(--forest, #1D5C38)', height: '10px', borderRadius: '999px' }} />
                      </div>
                      <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                        color: 'var(--forest-dark, #0F2018)' }}>
                        {t.jobs_total} job{t.jobs_total === 1 ? '' : 's'} · {t.jobs_delivered} done
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Live queue */}
          <div className="card" style={{ marginBottom: '1.5rem' }}>
            <div className="card-body" style={{ padding: '1.5rem' }}>
              <h2 style={{ fontSize: '1rem', margin: '0 0 1rem' }}>Live queue</h2>
              {queue.length === 0 ? (
                <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--ink-muted, #6B7280)' }}>
                  No active jobs right now.
                </p>
              ) : (
                queue.map((j) => {
                  const driver = [j.driver_first_name, j.driver_last_name].filter(Boolean).join(' ')
                  return (
                    <div key={j.id} style={{ display: 'flex', justifyContent: 'space-between',
                      gap: '1rem', alignItems: 'center', padding: '0.6rem 0',
                      borderTop: '1px solid rgba(15,48,32,0.06)', fontSize: '0.875rem', flexWrap: 'wrap' }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 600, color: 'var(--forest-dark, #0F2018)' }}>
                          {j.job_ref} <span style={{ fontWeight: 400, color: 'var(--ink-muted, #6B7280)',
                            textTransform: 'capitalize' }}>· {j.status.replace('_', ' ')}</span>
                        </div>
                        <div style={{ color: 'var(--ink-muted, #6B7280)', overflowWrap: 'anywhere' }}>
                          {j.pickup_address} → {j.delivery_address}
                        </div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{ugx(j.total_fare_ugx)}</div>
                        <div style={{ fontSize: '0.78rem', color: 'var(--ink-muted, #6B7280)' }}>
                          {driver ? `${driver}${j.driver_phone ? ` · ${j.driver_phone}` : ''}` : 'Awaiting driver'}
                        </div>
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          </div>

          {/* Billing */}
          <div className="card">
            <div className="card-body" style={{ padding: '1.5rem' }}>
              <h2 style={{ fontSize: '1rem', margin: '0 0 1rem' }}>Billing</h2>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem',
                padding: '0.55rem 0', borderTop: '1px solid rgba(15,48,32,0.06)', fontSize: '0.875rem' }}>
                <span style={{ color: 'var(--ink-muted, #6B7280)' }}>Jobs used this month</span>
                <span style={{ fontWeight: 600 }}>{billing ? billing.jobsUsedThisMonth : 0}</span>
              </div>
              {!billing?.subscription && (
                <p style={{ margin: '0.75rem 0 0', fontSize: '0.8rem', color: 'var(--ink-muted, #6B7280)' }}>
                  No paid subscription yet — you are on the starter plan.
                </p>
              )}
              {billing && billing.invoices.length === 0 && (
                <p style={{ margin: '0.35rem 0 0', fontSize: '0.8rem', color: 'var(--ink-muted, #6B7280)' }}>
                  No invoices yet.
                </p>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
