/**
 * Rheo Admin — Platform Dashboard tests (contract-verified edition)
 * Place at: apps/admin/src/app/dashboard/page.test.tsx  (replaces previous)
 *
 * The mock payload below mirrors the LIVE API contract captured on
 * 2026-07-05 — flat keys, numeric strings. If the backend ever changes
 * shape, update the contract here deliberately; test 7 guarantees drift
 * renders as zeros rather than crashing.
 *
 * Note: the previous XSS-inertness test was removed with the activity feed —
 * this page now renders numbers only, so the user-supplied-string surface
 * no longer exists.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import DashboardPage from './page'
import { redirectToLogin } from './navigation'

jest.mock('./navigation', () => ({ redirectToLogin: jest.fn() }))

function setAuthCookie() {
  document.cookie = 'rheo_access=test-token;Path=/'
}
function clearAuthCookie() {
  document.cookie = 'rheo_access=;Path=/;Expires=Thu, 01 Jan 1970 00:00:00 GMT'
}

// Live contract shape (numeric strings, flat keys)
function mockPayload(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    data: {
      approved_drivers: '31',
      pending_drivers: '5',
      online_drivers: '12',
      active_businesses: '9',
      pending_businesses: '1',
      jobs_today: '19',
      live_jobs: '7',
      commission_today_ugx: '450000',
      pending_withdrawals: '3',
      open_tickets: '6',
      driver_kyc_pending: '4',
      business_kyc_pending: '2',
      ...overrides,
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
test('redirects to /login and renders no KPI content when no access cookie', async () => {
  render(<DashboardPage />)
  await waitFor(() => expect(redirectToLogin).toHaveBeenCalled())
  expect(global.fetch).not.toHaveBeenCalled()
  expect(screen.queryByText(/drivers online/i)).not.toBeInTheDocument()
})

// 2 ───────────────────────────────────────────────────────────────────────
test('shows a loading state while the dashboard request is pending', () => {
  setAuthCookie()
  ;(global.fetch as jest.Mock).mockReturnValue(new Promise(() => {}))
  render(<DashboardPage />)
  expect(screen.getByText(/loading/i)).toBeInTheDocument()
})

// 3 ───────────────────────────────────────────────────────────────────────
test('renders KPI values from the live contract with UGX formatting', async () => {
  setAuthCookie()
  ;(global.fetch as jest.Mock).mockReturnValue(okResponse(mockPayload()))
  render(<DashboardPage />)
  expect(await screen.findByText('12')).toBeInTheDocument()          // online_drivers
  expect(screen.getByText('UGX 450,000')).toBeInTheDocument()        // commission_today_ugx
  expect(screen.getByText('31')).toBeInTheDocument()                 // approved_drivers
  expect(screen.getByText(/business kyc pending/i)).toBeInTheDocument()
  const call = (global.fetch as jest.Mock).mock.calls[0]
  expect(call[0]).toMatch(/\/admin\/dashboard$/)
  expect(call[1].headers.Authorization).toBe('Bearer test-token')
})

// 4 ───────────────────────────────────────────────────────────────────────
test('redirects to /login when the API returns 401', async () => {
  setAuthCookie()
  ;(global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 401, json: () => Promise.resolve({}) })
  render(<DashboardPage />)
  await waitFor(() => expect(redirectToLogin).toHaveBeenCalled())
})

// 5 ───────────────────────────────────────────────────────────────────────
test('shows error state on API failure and Retry refetches exactly once', async () => {
  setAuthCookie()
  ;(global.fetch as jest.Mock)
    .mockResolvedValueOnce({ ok: false, status: 500, json: () => Promise.resolve({}) })
    .mockReturnValueOnce(okResponse(mockPayload()))
  render(<DashboardPage />)
  const retry = await screen.findByRole('button', { name: /retry/i })
  await userEvent.click(retry)
  expect(await screen.findByText('UGX 450,000')).toBeInTheDocument()
  expect(global.fetch).toHaveBeenCalledTimes(2)
})

// 6 ───────────────────────────────────────────────────────────────────────
test('renders an empty platform gracefully — zeros, no NaN or undefined', async () => {
  setAuthCookie()
  const zeros = Object.fromEntries(
    Object.keys(mockPayload().data).map((k) => [k, '0'])
  )
  ;(global.fetch as jest.Mock).mockReturnValue(okResponse({ success: true, data: zeros }))
  render(<DashboardPage />)
  expect(await screen.findByText('UGX 0')).toBeInTheDocument()
  expect(document.body.textContent).not.toMatch(/NaN|undefined/)
})

// 7 ───────────────────────────────────────────────────────────────────────
test('never crashes on contract drift — unknown shape renders zeros', async () => {
  setAuthCookie()
  ;(global.fetch as jest.Mock).mockReturnValue(
    okResponse({ success: true, data: { totally: { different: 'shape' } } })
  )
  render(<DashboardPage />)
  expect(await screen.findByText('UGX 0')).toBeInTheDocument()
  expect(screen.getByText(/drivers online/i)).toBeInTheDocument()
  expect(document.body.textContent).not.toMatch(/NaN|undefined/)
})
