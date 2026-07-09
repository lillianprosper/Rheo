'use client'

/**
 * Rheo Business — Settings (v1: read-only)
 * Place at: apps/web/src/app/dashboard/settings/page.tsx
 * REPLACES the login-form placeholder previously at this route.
 *
 * CONTRACTS (both captured from the live wire, 2026-07-08):
 *   GET /businesses/me      → { success, data: { business profile … } }
 *   GET /businesses/me/team → { success, data: [ member … ] }
 *
 * v1 is deliberately READ-ONLY: the PATCH /businesses/me write schema has
 * not been wire-verified, and per the wire-first rule we do not guess write
 * contracts. Edit-profile and team-invite are registered fast-follows once
 * their schemas are captured.
 *
 * Security posture:
 *  - Bearer-only requests; tenant scoping is the JWT claim server-side.
 *  - The page displays the business's own contact PII to its own members —
 *    correct exposure. Nothing persisted to browser storage; nothing logged.
 *  - All values render as React text nodes; nulls render as em-dashes.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { redirectToLogin } from '../navigation'

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? ''

// ── Contract schemas (from the captured payloads) ────────────────────────────
const str = z.string().nullable().catch(null)

const ProfileSchema = z
  .object({
    business_name:      z.string().catch('—'),
    trading_name:       str,
    registration_no:    str,
    industry:           str,
    website:            str,
    status:             z.string().catch('unknown'),
    primary_email:      str,
    primary_phone:      str,
    address_line1:      str,
    address_line2:      str,
    city:               str,
    country:            str,
    kyc_status:         z.string().catch('unknown'),
    plan:               z.string().catch('—'),
    plan_billing:       str,
    plan_display_name:  str,
    commission_rate:    z.coerce.number().catch(0),   // "0.1200" → 0.12
    max_jobs_per_month: z.coerce.number().nullable().catch(null),
    max_team_members:   z.coerce.number().nullable().catch(null),
    jobs_this_month:    z.coerce.number().catch(0),
  })
  .passthrough()
  .catch({
    business_name: '—', trading_name: null, registration_no: null, industry: null,
    website: null, status: 'unknown', primary_email: null, primary_phone: null,
    address_line1: null, address_line2: null, city: null, country: null,
    kyc_status: 'unknown', plan: '—', plan_billing: null, plan_display_name: null,
    commission_rate: 0, max_jobs_per_month: null, max_team_members: null, jobs_this_month: 0,
  })

const MemberSchema = z
  .object({
    id:            z.string().catch(''),
    role:          z.string().catch('member'),
    first_name:    z.string().catch(''),
    last_name:     z.string().catch(''),
    email:         str,
    phone:         str,
    is_active:     z.boolean().catch(true),
    last_login_at: str,
  })
  .passthrough()

type Profile = z.infer<typeof ProfileSchema>
type Member  = z.infer<typeof MemberSchema>

const dash = (v: string | null | undefined): string => (v && v.trim() ? v : '—')
const pct  = (rate: number): string => `${Math.round(rate * 1000) / 10}%`

const getAccessToken = (): string | null => {
  const m = document.cookie.match(/(?:^|;\s*)rheo_access=([^;]*)/)
  return m ? decodeURIComponent(m[1]) : null
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem',
      padding: '0.55rem 0', borderTop: '1px solid rgba(15,48,32,0.06)', fontSize: '0.875rem' }}>
      <span style={{ color: 'var(--ink-muted, #6B7280)' }}>{label}</span>
      <span style={{ color: 'var(--forest-dark, #0F2018)', fontWeight: 500, textAlign: 'right',
        overflowWrap: 'anywhere' }}>{value}</span>
    </div>
  )
}

function Badge({ text, tone }: { text: string; tone: 'good' | 'warn' | 'muted' }) {
  const color = tone === 'good' ? '#15803D' : tone === 'warn' ? '#B45309' : '#6B7280'
  return (
    <span style={{ color, border: `1px solid ${color}`, borderRadius: '999px',
      padding: '0.1rem 0.6rem', fontSize: '0.72rem', fontWeight: 600, textTransform: 'capitalize' }}>
      {text.replace(/_/g, ' ')}
    </span>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function SettingsPage() {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [team,    setTeam]    = useState<Member[]>([])
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
      const headers = { Authorization: `Bearer ${token}` }
      const [meRes, teamRes] = await Promise.all([
        fetch(`${API_BASE}/businesses/me`, { headers }),
        fetch(`${API_BASE}/businesses/me/team`, { headers }),
      ])
      if (meRes.status === 401 || teamRes.status === 401) {
        redirectToLogin()
        return
      }
      if (!meRes.ok || !teamRes.ok) throw new Error('API error')
      const meBody   = await meRes.json()
      const teamBody = await teamRes.json()
      setProfile(ProfileSchema.parse(meBody?.data ?? {}))
      const list = Array.isArray(teamBody?.data) ? teamBody.data : []
      setTeam(list.map((m: unknown) => MemberSchema.parse(m ?? {})))
    } catch {
      setError('Could not load your settings.')
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

  if (!authorized.current && !loading && !profile && !error) return null

  const p = profile

  return (
    <div style={{ padding: '2rem', maxWidth: '840px' }}>
      <h1 style={{ fontSize: '1.4rem', margin: 0, color: 'var(--forest-dark, #0F2018)' }}>Settings</h1>
      <p style={{ margin: '0.25rem 0 1.5rem', fontSize: '0.85rem', color: 'var(--ink-muted, #6B7280)' }}>
        Your business profile, plan, and team
      </p>

      {loading && !p && <p style={{ color: 'var(--ink-muted, #6B7280)' }}>Loading settings…</p>}

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

      {p && (
        <>
          {/* Business profile */}
          <div className="card" style={{ marginBottom: '1.25rem' }}>
            <div className="card-body" style={{ padding: '1.5rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                <h2 style={{ fontSize: '1rem', margin: 0 }}>Business profile</h2>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <Badge text={p.status} tone={p.status === 'active' ? 'good' : 'warn'} />
                  <Badge text={`KYC ${p.kyc_status}`} tone={p.kyc_status === 'approved' ? 'good' : 'warn'} />
                </div>
              </div>
              <Row label="Business name"   value={p.business_name} />
              <Row label="Trading name"    value={dash(p.trading_name)} />
              <Row label="Registration no" value={dash(p.registration_no)} />
              <Row label="Industry"        value={dash(p.industry)} />
              <Row label="Website"         value={dash(p.website)} />
              <Row label="Email"           value={dash(p.primary_email)} />
              <Row label="Phone"           value={dash(p.primary_phone)} />
              <Row label="Address"         value={dash([p.address_line1, p.address_line2, p.city, p.country].filter(Boolean).join(', '))} />
              <p style={{ margin: '0.9rem 0 0', fontSize: '0.75rem', color: 'var(--ink-muted, #6B7280)' }}>
                Profile editing is coming soon. Contact support to change these details.
              </p>
            </div>
          </div>

          {/* Plan & usage */}
          <div className="card" style={{ marginBottom: '1.25rem' }}>
            <div className="card-body" style={{ padding: '1.5rem' }}>
              <h2 style={{ fontSize: '1rem', margin: '0 0 0.75rem' }}>Plan & usage</h2>
              <Row label="Plan"            value={dash(p.plan_display_name) !== '—' ? dash(p.plan_display_name) : p.plan} />
              <Row label="Billing"         value={dash(p.plan_billing)} />
              <Row label="Commission rate" value={pct(p.commission_rate)} />
              <Row label="Jobs this month" value={p.max_jobs_per_month
                ? `${p.jobs_this_month} of ${p.max_jobs_per_month}`
                : String(p.jobs_this_month)} />
            </div>
          </div>

          {/* Team */}
          <div className="card">
            <div className="card-body" style={{ padding: '1.5rem' }}>
              <h2 style={{ fontSize: '1rem', margin: '0 0 0.75rem' }}>Team</h2>
              {team.length === 0 ? (
                <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--ink-muted, #6B7280)' }}>No team members.</p>
              ) : (
                <div>
                  {team.map((m) => (
                    <div key={m.id} style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem',
                      alignItems: 'center', padding: '0.6rem 0', borderTop: '1px solid rgba(15,48,32,0.06)',
                      fontSize: '0.875rem' }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 600, color: 'var(--forest-dark, #0F2018)' }}>
                          {`${m.first_name} ${m.last_name}`.trim() || '—'}
                        </div>
                        <div style={{ color: 'var(--ink-muted, #6B7280)', overflowWrap: 'anywhere' }}>{dash(m.email)}</div>
                      </div>
                      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                        <Badge text={m.role} tone={m.role === 'owner' ? 'good' : 'muted'} />
                        {!m.is_active && <Badge text="inactive" tone="warn" />}
                      </div>
                    </div>
                  ))}
                  <p style={{ margin: '0.9rem 0 0', fontSize: '0.75rem', color: 'var(--ink-muted, #6B7280)' }}>
                    Team invites are coming soon.
                  </p>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
