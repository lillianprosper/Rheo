/**
 * Rheo Business — Overview page tests (contract-verified)
 * Place at: apps/web/src/app/dashboard/page.test.tsx
 *
 * The mock payload mirrors the LIVE wire capture of
 * GET /analytics/business/summary (2026-07-06): numeric-string KPIs,
 * numeric successRate, trend array. Contract changes must be made here
 * deliberately; test 7 guarantees drift renders zeros, never a crash.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import OverviewPage from './page'
import { redirectToLogin } from './navigation'

jest.mock('./navigation', () => ({ redirectToLogin: jest.fn() }))

function setAuthCookie() {
  document.cookie = 'rheo_access=test-token;Path=/'
}
function clearAuthCookie() {
  document.cookie = 'rheo_access=;Path=/;Expires=Thu, 01 Jan 1970 00:00:00 GMT'
}

// Live contract shape — captured from the wire
function mockPayload(overrides: { summary?: object; today?: object; trend?: unknown[] } = {}) {
  return {
    success: true,
    data: {
      summary: {
        jobs_total: '42',
        jobs_delivered: '38',
        jobs_failed: '1',
        jobs_cancelled: '3',
        total_spend_ugx: '1250000',
        avg_delivery_mins: '34',
        unique_drivers: '7',
        successRate: 97,
        ...(overrides.summary ?? {}),
      },
      today: {
        queued: '2',
        assigned: '1',
        in_transit: '3',
        delivered_today: '5',
        ...(overrides.today ?? {}),
      },
      trend: overrides.trend ?? [],
    },
  }
}

function okResponse(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })
}

beforeEach(() => {
  jest.clearAllMocks()
  clearAuthCookie()
  global.fetch = jest.fn()
})

// 1 ───────────────────────────────────────────────────────────────────────
test('redirects to login and renders no content when no access cookie', async () => {
  render(<OverviewPage />)
  await waitFor(() => expect(redirectToLogin).toHaveBeenCalled())
  expect(global.fetch).not.toHaveBeenCalled()
  expect(screen.queryByText(/total jobs/i)).not.toBeInTheDocument()
})

// 2 ───────────────────────────────────────────────────────────────────────
test('shows a loading state while the summary request is pending', () => {
  setAuthCookie()
  ;(global.fetch as jest.Mock).mockReturnValue(new Promise(() => {}))
  render(<OverviewPage />)
  expect(screen.getByText(/loading/i)).toBeInTheDocument()
})

// 3 ───────────────────────────────────────────────────────────────────────
test('renders KPIs from the live contract, hits the business-scoped endpoint with ONLY the Bearer header', async () => {
  setAuthCookie()
  ;(global.fetch as jest.Mock).mockReturnValue(okResponse(mockPayload()))
  render(<OverviewPage />)
  expect(await screen.findByText('UGX 1,250,000')).toBeInTheDocument()   // total_spend_ugx
  expect(screen.getByText('42')).toBeInTheDocument()                     // jobs_total
  expect(screen.getByText('34 min')).toBeInTheDocument()                 // avg_delivery_mins
  expect(screen.getByText(/in transit/i)).toBeInTheDocument()
  const [url, init] = (global.fetch as jest.Mock).mock.calls[0]
  expect(url).toMatch(/\/analytics\/business\/summary$/)                 // exact scoped path
  expect(init.headers.Authorization).toBe('Bearer test-token')
  // Scoping is server-side via JWT claim: the request must carry NO business id.
  expect(JSON.stringify(init)).not.toMatch(/business[_-]?id/i)
})

// 4 ───────────────────────────────────────────────────────────────────────
test('redirects to login when the API returns 401', async () => {
  setAuthCookie()
  ;(global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 401, json: () => Promise.resolve({}) })
  render(<OverviewPage />)
  await waitFor(() => expect(redirectToLogin).toHaveBeenCalled())
})

// 5 ───────────────────────────────────────────────────────────────────────
test('shows error state on API failure and Retry refetches exactly once', async () => {
  setAuthCookie()
  ;(global.fetch as jest.Mock)
    .mockResolvedValueOnce({ ok: false, status: 500, json: () => Promise.resolve({}) })
    .mockReturnValueOnce(okResponse(mockPayload()))
  render(<OverviewPage />)
  const retry = await screen.findByRole('button', { name: /retry/i })
  await userEvent.click(retry)
  expect(await screen.findByText('UGX 1,250,000')).toBeInTheDocument()
  expect(global.fetch).toHaveBeenCalledTimes(2)
})

// 6 ───────────────────────────────────────────────────────────────────────
test('renders an empty business gracefully — zeros, no NaN or undefined', async () => {
  setAuthCookie()
  const zeros = {
    summary: {
      jobs_total: '0', jobs_delivered: '0', jobs_failed: '0', jobs_cancelled: '0',
      total_spend_ugx: '0', avg_delivery_mins: '0', unique_drivers: '0', successRate: 0,
    },
    today: { queued: '0', assigned: '0', in_transit: '0', delivered_today: '0' },
  }
  ;(global.fetch as jest.Mock).mockReturnValue(okResponse(mockPayload(zeros)))
  render(<OverviewPage />)
  expect(await screen.findByText('UGX 0')).toBeInTheDocument()
  expect(document.body.textContent).not.toMatch(/NaN|undefined/)
})

// 7 ───────────────────────────────────────────────────────────────────────
test('never crashes on contract drift — unknown shape renders zeros', async () => {
  setAuthCookie()
  ;(global.fetch as jest.Mock).mockReturnValue(
    okResponse({ success: true, data: { totally: { different: 'shape' } } })
  )
  render(<OverviewPage />)
  expect(await screen.findByText('UGX 0')).toBeInTheDocument()
  expect(screen.getByText(/total jobs/i)).toBeInTheDocument()
  expect(document.body.textContent).not.toMatch(/NaN|undefined/)
})

// 8 ───────────────────────────────────────────────────────────────────────
test('renders success rate as a percentage from the numeric field', async () => {
  setAuthCookie()
  ;(global.fetch as jest.Mock).mockReturnValue(okResponse(mockPayload()))
  render(<OverviewPage />)
  expect(await screen.findByText('97%')).toBeInTheDocument()
})
