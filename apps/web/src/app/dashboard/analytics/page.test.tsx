/**
 * Rheo Business — Analytics tests
 * Place at: apps/web/src/app/dashboard/analytics/page.test.tsx
 * Mocks mirror LIVE wire captures (2026-07-09) of summary (incl. cron-built
 * trend rows), live-queue, and billing — including the pathological
 * avg_delivery_mins string "0.00000000000000000000".
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import AnalyticsPage from './page'
import { redirectToLogin } from '../navigation'

jest.mock('../navigation', () => ({ redirectToLogin: jest.fn() }))

function setAuthCookie() { document.cookie = 'rheo_access=test-token;Path=/' }
function clearAuthCookie() { document.cookie = 'rheo_access=;Path=/;Expires=Thu, 01 Jan 1970 00:00:00 GMT' }

const summaryBody = (over: Record<string, unknown> = {}) => ({
  success: true,
  data: {
    summary: {
      jobs_total: '1', jobs_delivered: '0', jobs_failed: '0', jobs_cancelled: '0',
      total_spend_ugx: '0.00', avg_delivery_mins: '0.00000000000000000000',
      unique_drivers: '0', successRate: 0,
    },
    today: { queued: '0', assigned: '0', in_transit: '0', delivered_today: '0' },
    trend: [
      { date: '2026-07-06T00:00:00.000Z', jobs_total: 0, jobs_delivered: 0, total_spend_ugx: '0.00' },
      { date: '2026-07-07T00:00:00.000Z', jobs_total: 1, jobs_delivered: 0, total_spend_ugx: '0.00' },
    ],
    ...over,
  },
})

const queueBody = (rows: unknown[] = [{
  id: 'f2c01796', job_ref: 'RHO-20260707-00001', status: 'queued',
  pickup_address: 'Shop 1 nakasero road mall', delivery_address: 'ntinda shopping mall',
  total_fare_ugx: '60000.00', created_at: '2026-07-07T15:47:16.053Z',
  assigned_at: null, picked_up_at: null,
  driver_first_name: null, driver_last_name: null, driver_phone: null,
  last_lat: null, last_lng: null,
}]) => ({ success: true, data: rows })

const billingBody = (over: Record<string, unknown> = {}) => ({
  success: true,
  data: { subscription: null, invoices: [], jobsUsedThisMonth: 1, ...over },
})

function ok(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })
}

function mockAll(s: unknown, q: unknown, b: unknown) {
  ;(global.fetch as jest.Mock).mockImplementation((url: string) => {
    if (url.includes('live-queue')) return ok(q)
    if (url.includes('billing'))    return ok(b)
    return ok(s)
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  clearAuthCookie()
  global.fetch = jest.fn()
})

// 1 ───────────────────────────────────────────────────────────────────────
test('redirects to login and fetches nothing when no access cookie', async () => {
  render(<AnalyticsPage />)
  await waitFor(() => expect(redirectToLogin).toHaveBeenCalled())
  expect(global.fetch).not.toHaveBeenCalled()
  expect(screen.queryByText('RHO-20260707-00001')).not.toBeInTheDocument()
})

// 2 ───────────────────────────────────────────────────────────────────────
test('shows a loading state while requests are pending', () => {
  setAuthCookie()
  ;(global.fetch as jest.Mock).mockReturnValue(new Promise(() => {}))
  render(<AnalyticsPage />)
  expect(screen.getByText(/loading analytics/i)).toBeInTheDocument()
})

// 3 ───────────────────────────────────────────────────────────────────────
test('calls all three business analytics endpoints Bearer-only and renders KPIs', async () => {
  setAuthCookie()
  mockAll(summaryBody(), queueBody(), billingBody())
  render(<AnalyticsPage />)
  expect(await screen.findByText(/total jobs/i)).toBeInTheDocument()
  // pathological avg string coerces cleanly to "0 min"
  expect(screen.getByText('0 min')).toBeInTheDocument()
  const urls = (global.fetch as jest.Mock).mock.calls.map(([u]) => u)
  expect(urls.some((u: string) => /\/analytics\/business\/summary$/.test(u))).toBe(true)
  expect(urls.some((u: string) => /\/analytics\/business\/live-queue$/.test(u))).toBe(true)
  expect(urls.some((u: string) => /\/analytics\/business\/billing$/.test(u))).toBe(true)
  for (const [, init] of (global.fetch as jest.Mock).mock.calls) {
    expect(init.headers.Authorization).toBe('Bearer test-token')
  }
})

// 4 ───────────────────────────────────────────────────────────────────────
test('renders trend rows from the cron-built wire shape', async () => {
  setAuthCookie()
  mockAll(summaryBody(), queueBody(), billingBody())
  render(<AnalyticsPage />)
  expect(await screen.findByText(/1 job · 0 done/i)).toBeInTheDocument()   // Jul 7 row
  expect(screen.getByText(/0 jobs · 0 done/i)).toBeInTheDocument()          // Jul 6 row
})

// 5 ───────────────────────────────────────────────────────────────────────
test('live queue shows the job with fare and Awaiting driver when unassigned', async () => {
  setAuthCookie()
  mockAll(summaryBody(), queueBody(), billingBody())
  render(<AnalyticsPage />)
  expect(await screen.findByText('RHO-20260707-00001')).toBeInTheDocument()
  expect(screen.getByText('UGX 60,000')).toBeInTheDocument()
  expect(screen.getByText(/awaiting driver/i)).toBeInTheDocument()
})

// 6 ───────────────────────────────────────────────────────────────────────
test('billing shows monthly usage and the no-subscription state', async () => {
  setAuthCookie()
  mockAll(summaryBody(), queueBody(), billingBody())
  render(<AnalyticsPage />)
  expect(await screen.findByText(/jobs used this month/i)).toBeInTheDocument()
  expect(screen.getByText(/no paid subscription yet/i)).toBeInTheDocument()
  expect(screen.getByText(/no invoices yet/i)).toBeInTheDocument()
})

// 7 ───────────────────────────────────────────────────────────────────────
test('redirects to login when any endpoint returns 401', async () => {
  setAuthCookie()
  ;(global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 401, json: () => Promise.resolve({}) })
  render(<AnalyticsPage />)
  await waitFor(() => expect(redirectToLogin).toHaveBeenCalled())
})

// 8 ───────────────────────────────────────────────────────────────────────
test('shows error state on failure and Retry refetches', async () => {
  setAuthCookie()
  ;(global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) })
  render(<AnalyticsPage />)
  const retry = await screen.findByRole('button', { name: /retry/i })
  mockAll(summaryBody(), queueBody(), billingBody())
  await userEvent.click(retry)
  expect(await screen.findByText('RHO-20260707-00001')).toBeInTheDocument()
})

// 9 ───────────────────────────────────────────────────────────────────────
test('never crashes on contract drift — alien shapes render empty states, no NaN/undefined', async () => {
  setAuthCookie()
  mockAll({ success: true, data: { weird: true } },
          { success: true, data: 'not-an-array' },
          { success: true, data: null })
  render(<AnalyticsPage />)
  expect(await screen.findByText(/no history yet/i)).toBeInTheDocument()
  expect(screen.getByText(/no active jobs right now/i)).toBeInTheDocument()
  expect(document.body.textContent).not.toMatch(/NaN|undefined/)
})
