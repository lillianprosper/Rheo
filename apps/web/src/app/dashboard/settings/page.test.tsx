/**
 * Rheo Business — Settings tests
 * Place at: apps/web/src/app/dashboard/settings/page.test.tsx
 * Mocks mirror the LIVE wire captures of /businesses/me and
 * /businesses/me/team (2026-07-08).
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SettingsPage from './page'
import { redirectToLogin } from '../navigation'

jest.mock('../navigation', () => ({ redirectToLogin: jest.fn() }))

function setAuthCookie() {
  document.cookie = 'rheo_access=test-token;Path=/'
}
function clearAuthCookie() {
  document.cookie = 'rheo_access=;Path=/;Expires=Thu, 01 Jan 1970 00:00:00 GMT'
}

// Wire-shaped mocks (2026-07-08 capture)
const profile = (over: Record<string, unknown> = {}) => ({
  success: true,
  data: {
    id: 'biz-1', business_name: 'Rheo Transport', trading_name: null,
    registration_no: null, industry: null, website: null, logo_url: null,
    status: 'active', primary_email: 'owner@example.com', primary_phone: '070000000',
    address_line1: null, address_line2: null, city: 'Kampala', country: 'Uganda',
    kyc_status: 'not_submitted', plan: 'starter', plan_billing: 'monthly',
    plan_started_at: null, plan_renews_at: null, commission_rate: '0.1200',
    subscription_status: null, plan_display_name: null,
    max_jobs_per_month: null, max_team_members: null, jobs_this_month: '1',
    ...over,
  },
})

const teamBody = (members: unknown[] = [{
  id: 'm1', role: 'owner', first_name: 'Admin', last_name: 'Rheo',
  phone: null, avatar_url: null, is_active: true,
  created_at: '2026-06-28T22:05:38.081Z', email: 'owner@example.com',
  last_login_at: '2026-07-08T14:14:46.233Z',
}]) => ({ success: true, data: members })

function ok(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })
}

/** Route the two parallel fetches by URL. */
function mockBoth(me: unknown, team: unknown) {
  ;(global.fetch as jest.Mock).mockImplementation((url: string) =>
    url.includes('/team') ? ok(team) : ok(me)
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  clearAuthCookie()
  global.fetch = jest.fn()
})

// 1 ───────────────────────────────────────────────────────────────────────
test('redirects to login and renders no content when no access cookie', async () => {
  render(<SettingsPage />)
  await waitFor(() => expect(redirectToLogin).toHaveBeenCalled())
  expect(global.fetch).not.toHaveBeenCalled()
  // The static page chrome (heading/subtitle) may render; assert no DATA did.
  expect(screen.queryByText('Rheo Transport')).not.toBeInTheDocument()
  expect(screen.queryByText(/plan & usage/i)).not.toBeInTheDocument()
})

// 2 ───────────────────────────────────────────────────────────────────────
test('shows a loading state while requests are pending', () => {
  setAuthCookie()
  ;(global.fetch as jest.Mock).mockReturnValue(new Promise(() => {}))
  render(<SettingsPage />)
  expect(screen.getByText(/loading settings/i)).toBeInTheDocument()
})

// 3 ───────────────────────────────────────────────────────────────────────
test('renders profile, plan and usage from the wire contract, Bearer-only', async () => {
  setAuthCookie()
  mockBoth(profile(), teamBody())
  render(<SettingsPage />)
  expect(await screen.findByText('Rheo Transport')).toBeInTheDocument()
  expect(screen.getByText('12%')).toBeInTheDocument()          // commission_rate "0.1200"
  expect(screen.getByText('starter')).toBeInTheDocument()      // plan fallback (no display name)
  expect(screen.getByText('1')).toBeInTheDocument()            // jobs_this_month, no limit set
  const calls = (global.fetch as jest.Mock).mock.calls
  expect(calls.some(([u]) => /\/businesses\/me$/.test(u))).toBe(true)
  expect(calls.some(([u]) => /\/businesses\/me\/team$/.test(u))).toBe(true)
  for (const [, init] of calls) {
    expect(init.headers.Authorization).toBe('Bearer test-token')
  }
})

// 4 ───────────────────────────────────────────────────────────────────────
test('renders team members with role badge and email', async () => {
  setAuthCookie()
  mockBoth(profile(), teamBody())
  render(<SettingsPage />)
  expect(await screen.findByText('Admin Rheo')).toBeInTheDocument()
  expect(screen.getAllByText('owner@example.com').length).toBeGreaterThan(0)
  expect(screen.getByText('owner')).toBeInTheDocument()
})

// 5 ───────────────────────────────────────────────────────────────────────
test('renders null fields as em-dashes — never the strings null or undefined', async () => {
  setAuthCookie()
  mockBoth(profile(), teamBody())
  render(<SettingsPage />)
  await screen.findByText('Rheo Transport')
  expect(document.body.textContent).not.toMatch(/null|undefined|NaN/)
  expect(screen.getAllByText('—').length).toBeGreaterThan(0)   // trading name, website, etc.
})

// 6 ───────────────────────────────────────────────────────────────────────
test('redirects to login when either API returns 401', async () => {
  setAuthCookie()
  ;(global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 401, json: () => Promise.resolve({}) })
  render(<SettingsPage />)
  await waitFor(() => expect(redirectToLogin).toHaveBeenCalled())
})

// 7 ───────────────────────────────────────────────────────────────────────
test('shows error state on API failure and Retry refetches', async () => {
  setAuthCookie()
  ;(global.fetch as jest.Mock)
    .mockResolvedValueOnce({ ok: false, status: 500, json: () => Promise.resolve({}) })
    .mockResolvedValueOnce({ ok: false, status: 500, json: () => Promise.resolve({}) })
  render(<SettingsPage />)
  const retry = await screen.findByRole('button', { name: /retry/i })
  mockBoth(profile(), teamBody())
  await userEvent.click(retry)
  expect(await screen.findByText('Rheo Transport')).toBeInTheDocument()
})

// 8 ───────────────────────────────────────────────────────────────────────
test('never crashes on contract drift — alien shapes render placeholders', async () => {
  setAuthCookie()
  mockBoth({ success: true, data: { totally: 'different' } },
           { success: true, data: 'not-an-array' })
  render(<SettingsPage />)
  // Wait for the drift-tolerated render to settle on a data-section element.
  expect(await screen.findByText(/no team members/i)).toBeInTheDocument()
  expect(screen.getByText(/plan & usage/i)).toBeInTheDocument()
  expect(document.body.textContent).not.toMatch(/undefined|NaN/)
})
