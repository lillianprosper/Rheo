/**
 * Rheo Admin — Platform Dashboard tests (TDD gate)
 * Place at: apps/admin/src/app/dashboard/page.test.tsx
 *
 * Outcome-based tests per the agreed blueprint:
 *  1. Auth gate      — no cookie → redirect to /login, no KPI content
 *  2. Loading state  — pending fetch → loading indicator
 *  3. Happy path     — KPI values render, UGX formatted
 *  4. Token expiry   — API 401 → redirect to /login
 *  5. API failure    — error state + Retry refetches exactly once
 *  6. Activity XSS   — audit strings render as inert text
 *  7. Empty platform — zeros render, no NaN/undefined
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import DashboardPage from './page'
import { redirectToLogin } from './navigation'

// jsdom cannot navigate and its window.location is non-configurable, so the
// page routes all redirects through ./navigation — mocked here as a seam.
jest.mock('./navigation', () => ({ redirectToLogin: jest.fn() }))

function setAuthCookie() {
  document.cookie = 'rheo_access=test-token;Path=/'
}
function clearAuthCookie() {
  document.cookie = 'rheo_access=;Path=/;Expires=Thu, 01 Jan 1970 00:00:00 GMT'
}

// Mirrors the shape returned by GET /api/v1/admin/dashboard
function mockPayload(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    data: {
      jobs:        { queued: '4', in_transit: '7', delivered_today: '19' },
      drivers:     { approved: '31', pending: '5', online: '12' },
      businesses:  { active: '9', pending: '2' },
      revenue:     { today: '450000' },
      withdrawals: { count: '3', total: '120000' },
      tickets:     { open: '6', critical: '1' },
      recentActivity: [
        {
          action: 'driver.approve',
          actor_type: 'staff',
          actor_role: 'admin',
          resource_type: 'driver',
          created_at: new Date().toISOString(),
        },
      ],
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
  ;(global.fetch as jest.Mock).mockReturnValue(new Promise(() => {})) // never resolves
  render(<DashboardPage />)
  expect(screen.getByText(/loading/i)).toBeInTheDocument()
})

// 3 ───────────────────────────────────────────────────────────────────────
test('renders KPI values from the API with UGX formatting', async () => {
  setAuthCookie()
  ;(global.fetch as jest.Mock).mockReturnValue(okResponse(mockPayload()))
  render(<DashboardPage />)
  expect(await screen.findByText('12')).toBeInTheDocument()            // drivers online
  expect(screen.getByText('UGX 450,000')).toBeInTheDocument()          // revenue today
  expect(screen.getByText(/drivers online/i)).toBeInTheDocument()
  const call = (global.fetch as jest.Mock).mock.calls[0]
  expect(call[0]).toMatch(/\/admin\/dashboard$/)                       // correct endpoint
  expect(call[1].headers.Authorization).toBe('Bearer test-token')      // token attached
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
test('renders audit activity strings as inert text (no script execution)', async () => {
  setAuthCookie()
  const payload = mockPayload({
    recentActivity: [{
      action: '<script>alert(1)</script>',
      actor_type: 'staff',
      actor_role: 'admin',
      resource_type: 'driver',
      created_at: new Date().toISOString(),
    }],
  })
  ;(global.fetch as jest.Mock).mockReturnValue(okResponse(payload))
  const { container } = render(<DashboardPage />)
  expect(await screen.findByText('<script>alert(1)</script>')).toBeInTheDocument()
  expect(container.querySelector('script')).toBeNull()
})

// 7 ───────────────────────────────────────────────────────────────────────
test('renders an empty platform gracefully — zeros, no NaN or undefined', async () => {
  setAuthCookie()
  const payload = mockPayload({
    jobs:        { queued: '0', in_transit: '0', delivered_today: '0' },
    drivers:     { approved: '0', pending: '0', online: '0' },
    businesses:  { active: '0', pending: '0' },
    revenue:     { today: '0' },
    withdrawals: { count: '0', total: '0' },
    tickets:     { open: '0', critical: '0' },
    recentActivity: [],
  })
  ;(global.fetch as jest.Mock).mockReturnValue(okResponse(payload))
  render(<DashboardPage />)
  expect(await screen.findByText('UGX 0')).toBeInTheDocument()
  expect(document.body.textContent).not.toMatch(/NaN|undefined/)
})
