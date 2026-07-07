'use client'

/**
 * Rheo Business — Create Job
 * Place at: apps/web/src/app/dashboard/jobs/new/page.tsx
 * REPLACES the login-form placeholder previously at this route.
 *
 * CONTRACT: POST {NEXT_PUBLIC_API_URL}/jobs — client schema below mirrors the
 * API's Zod schema (job.routes.ts) field-for-field on the subset collected:
 * description ≥5, pickupAddress ≥5, deliveryAddress ≥5, baseFareUgx > 0,
 * optional contacts / notes / weightKg / fragile. Lat/lng and scheduledFor
 * are deliberately deferred to a follow-up (map picker) to keep this module
 * lean. Server re-validates everything — belt and suspenders.
 *
 * Security posture:
 *  - Double-submit guard: the button hard-disables in flight and on success
 *    we hard-navigate away (never re-enable) — job creation is billable and
 *    counts against subscription limits; two clicks must never mean two jobs.
 *  - PII (contact names/phones, addresses) is never persisted to browser
 *    storage and never console-logged. Failure banners show the server's
 *    message only — never an echo of the submitted payload.
 *  - Bearer-only request; business scoping is the JWT claim server-side.
 *
 * UX guarantee: on any failure the user's typed input is preserved —
 * a form that eats ten minutes of typing loses customers permanently.
 */

import { useState, FormEvent } from 'react'
import { z } from 'zod'
import { redirectToLogin, goToJobs } from '../../navigation'

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? ''
const MAX_FARE_UGX = 10_000_000 // client-side sanity ceiling; server is authority

// ── Client schema — mirrors the API's job creation schema (subset) ──────────
const JobFormSchema = z.object({
  description:          z.string().min(5, 'Describe the delivery (at least 5 characters)'),
  pickupAddress:        z.string().min(5, 'Pickup address must be at least 5 characters'),
  pickupContactName:    z.string().optional(),
  pickupContactPhone:   z.string().optional(),
  deliveryAddress:      z.string().min(5, 'Delivery address must be at least 5 characters'),
  deliveryContactName:  z.string().optional(),
  deliveryContactPhone: z.string().optional(),
  deliveryNotes:        z.string().optional(),
  weightKg:             z.number().positive('Weight must be positive').optional(),
  fragile:              z.boolean(),
  baseFareUgx:          z.number({ invalid_type_error: 'Enter the fare in UGX' })
                          .positive('Fare must be greater than zero')
                          .max(MAX_FARE_UGX, 'Fare looks too large — check the amount'),
})

type FieldErrors = Partial<Record<string, string>>

const getAccessToken = (): string | null => {
  const m = document.cookie.match(/(?:^|;\s*)rheo_access=([^;]*)/)
  return m ? decodeURIComponent(m[1]) : null
}

const inputStyle = {
  width: '100%', padding: '0.6rem 0.75rem', borderRadius: '8px',
  border: '1px solid #D1D5DB', fontSize: '0.9rem', boxSizing: 'border-box' as const,
}
const labelStyle = {
  display: 'block', fontSize: '0.78rem', fontWeight: 600,
  color: 'var(--forest-dark, #0F2018)', marginBottom: '0.3rem',
}
const errStyle = { color: '#B91C1C', fontSize: '0.75rem', marginTop: '0.25rem' }

function Field({ id, label, error, children }: {
  id: string; label: string; error?: string; children: React.ReactNode
}) {
  return (
    <div style={{ marginBottom: '1rem' }}>
      <label htmlFor={id} style={labelStyle}>{label}</label>
      {children}
      {error && <div role="alert" style={errStyle}>{error}</div>}
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function NewJobPage() {
  const [form, setForm] = useState({
    description: '', pickupAddress: '', pickupContactName: '', pickupContactPhone: '',
    deliveryAddress: '', deliveryContactName: '', deliveryContactPhone: '',
    deliveryNotes: '', weightKg: '', fragile: false, baseFareUgx: '',
  })
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [apiError,    setApiError]    = useState<string>('')
  const [submitting,  setSubmitting]  = useState<boolean>(false)

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value }))

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (submitting) return // double-submit guard, belt one
    setApiError('')
    setFieldErrors({})

    // Build a typed candidate: empty optionals omitted, numerics coerced
    const candidate = {
      description:          form.description.trim(),
      pickupAddress:        form.pickupAddress.trim(),
      pickupContactName:    form.pickupContactName.trim() || undefined,
      pickupContactPhone:   form.pickupContactPhone.trim() || undefined,
      deliveryAddress:      form.deliveryAddress.trim(),
      deliveryContactName:  form.deliveryContactName.trim() || undefined,
      deliveryContactPhone: form.deliveryContactPhone.trim() || undefined,
      deliveryNotes:        form.deliveryNotes.trim() || undefined,
      weightKg:             form.weightKg.trim() ? Number(form.weightKg) : undefined,
      fragile:              form.fragile,
      baseFareUgx:          form.baseFareUgx.trim() ? Number(form.baseFareUgx) : NaN,
    }

    const parsed = JobFormSchema.safeParse(candidate)
    if (!parsed.success) {
      const errs: FieldErrors = {}
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? 'form')
        if (!errs[key]) errs[key] = issue.message
      }
      setFieldErrors(errs)
      return // invalid input never reaches the network
    }

    setSubmitting(true) // double-submit guard, belt two
    try {
      const token = getAccessToken()
      if (!token) {
        redirectToLogin()
        return
      }
      const res = await fetch(`${API_BASE}/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(parsed.data),
      })
      if (res.status === 401) {
        redirectToLogin()
        return
      }
      if (!res.ok) {
        // Surface the server's message (e.g., monthly job limit reached) —
        // never echo the submitted payload.
        let message = 'Could not create the job. Please try again.'
        try {
          const body = await res.json()
          if (body?.error?.message) message = String(body.error.message)
        } catch { /* keep default */ }
        setApiError(message)
        setSubmitting(false) // failure: re-enable so the user can retry
        return
      }
      // Success: creation is billable and done — navigate away, never re-enable.
      goToJobs()
    } catch {
      setApiError('Could not reach the server. Your details are still here — try again.')
      setSubmitting(false)
    }
  }

  return (
    <div style={{ padding: '2rem', maxWidth: '640px' }}>
      <h1 style={{ fontSize: '1.4rem', margin: 0, color: 'var(--forest-dark, #0F2018)' }}>New job</h1>
      <p style={{ margin: '0.25rem 0 1.5rem', fontSize: '0.85rem', color: 'var(--ink-muted, #6B7280)' }}>
        Create a delivery job. A driver will be assigned once it is queued.
      </p>

      {apiError && (
        <div role="alert" style={{ background: '#FEE2E2', color: '#B91C1C', padding: '1rem 1.25rem',
          borderRadius: '8px', marginBottom: '1.25rem', borderLeft: '3px solid #DC2626' }}>
          {apiError}
        </div>
      )}

      <form onSubmit={handleSubmit} noValidate>
        <div className="card">
          <div className="card-body" style={{ padding: '1.5rem' }}>
            <Field id="description" label="What is being delivered?" error={fieldErrors.description}>
              <textarea id="description" rows={2} style={inputStyle}
                value={form.description} onChange={set('description')}
                placeholder="e.g. 2 boxes of shoes for a customer" />
            </Field>

            <h2 style={{ fontSize: '0.8rem', letterSpacing: '0.06em', textTransform: 'uppercase',
              color: 'var(--ink-muted, #6B7280)', margin: '1.25rem 0 0.75rem' }}>Pickup</h2>
            <Field id="pickupAddress" label="Pickup address" error={fieldErrors.pickupAddress}>
              <input id="pickupAddress" style={inputStyle} value={form.pickupAddress}
                onChange={set('pickupAddress')} placeholder="Shop 12, Nakasero Market, Kampala" />
            </Field>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
              <Field id="pickupContactName" label="Contact name (optional)" error={fieldErrors.pickupContactName}>
                <input id="pickupContactName" style={inputStyle} value={form.pickupContactName} onChange={set('pickupContactName')} />
              </Field>
              <Field id="pickupContactPhone" label="Contact phone (optional)" error={fieldErrors.pickupContactPhone}>
                <input id="pickupContactPhone" style={inputStyle} value={form.pickupContactPhone} onChange={set('pickupContactPhone')} inputMode="tel" />
              </Field>
            </div>

            <h2 style={{ fontSize: '0.8rem', letterSpacing: '0.06em', textTransform: 'uppercase',
              color: 'var(--ink-muted, #6B7280)', margin: '1.25rem 0 0.75rem' }}>Delivery</h2>
            <Field id="deliveryAddress" label="Delivery address" error={fieldErrors.deliveryAddress}>
              <input id="deliveryAddress" style={inputStyle} value={form.deliveryAddress}
                onChange={set('deliveryAddress')} placeholder="Ntinda Shopping Centre, Kampala" />
            </Field>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
              <Field id="deliveryContactName" label="Contact name (optional)" error={fieldErrors.deliveryContactName}>
                <input id="deliveryContactName" style={inputStyle} value={form.deliveryContactName} onChange={set('deliveryContactName')} />
              </Field>
              <Field id="deliveryContactPhone" label="Contact phone (optional)" error={fieldErrors.deliveryContactPhone}>
                <input id="deliveryContactPhone" style={inputStyle} value={form.deliveryContactPhone} onChange={set('deliveryContactPhone')} inputMode="tel" />
              </Field>
            </div>
            <Field id="deliveryNotes" label="Delivery notes (optional)" error={fieldErrors.deliveryNotes}>
              <input id="deliveryNotes" style={inputStyle} value={form.deliveryNotes} onChange={set('deliveryNotes')} />
            </Field>

            <h2 style={{ fontSize: '0.8rem', letterSpacing: '0.06em', textTransform: 'uppercase',
              color: 'var(--ink-muted, #6B7280)', margin: '1.25rem 0 0.75rem' }}>Package & fare</h2>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
              <Field id="weightKg" label="Weight kg (optional)" error={fieldErrors.weightKg}>
                <input id="weightKg" style={inputStyle} value={form.weightKg} onChange={set('weightKg')}
                  inputMode="decimal" placeholder="e.g. 4.5" />
              </Field>
              <Field id="baseFareUgx" label="Fare (UGX)" error={fieldErrors.baseFareUgx}>
                <input id="baseFareUgx" style={inputStyle} value={form.baseFareUgx} onChange={set('baseFareUgx')}
                  inputMode="numeric" placeholder="e.g. 15000" />
              </Field>
            </div>
            <div style={{ margin: '0.25rem 0 0.5rem' }}>
              <label htmlFor="fragile" style={{ fontSize: '0.85rem', color: 'var(--forest-dark, #0F2018)',
                display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                <input id="fragile" type="checkbox" checked={form.fragile} onChange={set('fragile')} />
                Fragile — handle with care
              </label>
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1.25rem' }}>
          <button type="submit" className="btn btn-primary" disabled={submitting}
            style={{ padding: '0.7rem 1.4rem', opacity: submitting ? 0.7 : 1,
              cursor: submitting ? 'default' : 'pointer' }}>
            {submitting ? 'Creating…' : 'Create job'}
          </button>
          <a href="/dashboard/jobs" style={{ padding: '0.7rem 1rem', fontSize: '0.9rem',
            color: 'var(--ink-muted, #6B7280)', textDecoration: 'none', alignSelf: 'center' }}>
            Cancel
          </a>
        </div>
      </form>
    </div>
  )
}
