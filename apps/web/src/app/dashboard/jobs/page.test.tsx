/**
 * Rheo Business — Jobs list tests
 * Place at: apps/web/src/app/dashboard/jobs/page.test.tsx
 *
 * Envelope AND row mocks mirror LIVE wire captures:
 *   envelope 2026-07-06; row pinned 2026-07-07 from the first real job
 *   (RHO-20260707-00001) — money fields are decimal strings ("60000.00"),
 *   displayed fare is total_fare_ugx.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import JobsPage from './page'
import { redirectToLogin } from '../navigation'

jest.mock('../navigation', () => ({ redirectToLogin: jest.fn() }))

function setAuthCookie() {
  document.cookie = 'rheo_access=test-token;Path=/'
}
function clearAuthCookie() {
  document.cookie = 'rheo_access=;Path=/;Expires=Thu, 01 Jan 1970 00:00:00 GMT'
}

// Subset of the wire-verified row (full capture has 40+ fields; extras pass through)
const row = (over: Record<string, unknown> = {}) => ({
  id: 'a1b2', job_ref: 'RHEO-0001', status: 'queued',
  pickup_address: 'Nakasero Market, Kampala',
  delivery_address: 'Ntinda Shopping Centre, Kampala',
  base_fare_ugx: '15000.00', total_fare_ugx: '15000.00',
  created_at: '2026-07-06T10:00:00Z',
  ...over,
})

const envelope = (data: unknown[], meta: Record<string, unknown> = {}) => ({
  success: true,
  data,
  meta: { total: data.length, page: 1, limit: 20, pages: 1, hasNext: false, hasPrev: false, ...meta },
})

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
  render(<JobsPage />)
  await waitFor(() => expect(redirectToLogin).toHaveBeenCalled())
  expect(global.fetch).not.toHaveBeenCalled()
  expect(screen.queryByText(/no jobs yet/i)).not.toBeInTheDocument()
})

// 2 ───────────────────────────────────────────────────────────────────────
test('shows a loading state while the request is pending', () => {
  setAuthCookie()
  ;(global.fetch as jest.Mock).mockReturnValue(new Promise(() => {}))
  render(<JobsPage />)
  expect(screen.getByText(/loading jobs/i)).toBeInTheDocument()
})

// 3 ───────────────────────────────────────────────────────────────────────
test('renders job rows, hits the business-scoped endpoint with ONLY the Bearer header', async () => {
  setAuthCookie()
  ;(global.fetch as jest.Mock).mockReturnValue(okResponse(envelope([row()])))
  render(<JobsPage />)
  expect(await screen.findByText('RHEO-0001')).toBeInTheDocument()
  expect(screen.getByText(/nakasero market/i)).toBeInTheDocument()
  expect(screen.getByText('UGX 15,000')).toBeInTheDocument()
  const [url, init] = (global.fetch as jest.Mock).mock.calls[0]
  expect(url).toMatch(/\/jobs\/business\?/)
  expect(url).toMatch(/page=1/)
  expect(url).toMatch(/limit=20/)
  expect(init.headers.Authorization).toBe('Bearer test-token')
  // Scoping is server-side via JWT claim — no business id may appear anywhere
  expect(url + JSON.stringify(init)).not.toMatch(/business[_-]?id/i)
})

// 4 ───────────────────────────────────────────────────────────────────────
test('shows the empty state with a create-first-job pointer', async () => {
  setAuthCookie()
  ;(global.fetch as jest.Mock).mockReturnValue(okResponse(envelope([])))
  render(<JobsPage />)
  expect(await screen.findByText(/no jobs yet/i)).toBeInTheDocument()
  const cta = screen.getByRole('link', { name: /create your first job/i })
  expect(cta).toHaveAttribute('href', '/dashboard/jobs/new')
})

// 5 ───────────────────────────────────────────────────────────────────────
test('pagination honors meta: Next enabled by hasNext and requests page=2', async () => {
  setAuthCookie()
  ;(global.fetch as jest.Mock)
    .mockReturnValueOnce(okResponse(envelope([row()], { pages: 2, hasNext: true })))
    .mockReturnValueOnce(okResponse(envelope([row({ job_ref: 'RHEO-0021' })], { page: 2, pages: 2, hasPrev: true })))
  render(<JobsPage />)
  const next = await screen.findByRole('button', { name: /next/i })
  expect(next).toBeEnabled()
  expect(screen.getByRole('button', { name: /previous/i })).toBeDisabled() // hasPrev false
  await userEvent.click(next)
  expect(await screen.findByText('RHEO-0021')).toBeInTheDocument()
  const secondUrl = (global.fetch as jest.Mock).mock.calls[1][0]
  expect(secondUrl).toMatch(/page=2/)
})

// 6 ───────────────────────────────────────────────────────────────────────
test('status filter emits the constrained status query param and resets to page 1', async () => {
  setAuthCookie()
  ;(global.fetch as jest.Mock).mockReturnValue(okResponse(envelope([row()])))
  render(<JobsPage />)
  await screen.findByText('RHEO-0001')
  await userEvent.selectOptions(screen.getByLabelText(/status/i), 'delivered')
  await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2))
  const secondUrl = (global.fetch as jest.Mock).mock.calls[1][0]
  expect(secondUrl).toMatch(/status=delivered/)
  expect(secondUrl).toMatch(/page=1/)
})

// 7 ───────────────────────────────────────────────────────────────────────
test('redirects to login when the API returns 401', async () => {
  setAuthCookie()
  ;(global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 401, json: () => Promise.resolve({}) })
  render(<JobsPage />)
  await waitFor(() => expect(redirectToLogin).toHaveBeenCalled())
})

// 8 ───────────────────────────────────────────────────────────────────────
test('shows error state on API failure and Retry refetches exactly once', async () => {
  setAuthCookie()
  ;(global.fetch as jest.Mock)
    .mockResolvedValueOnce({ ok: false, status: 500, json: () => Promise.resolve({}) })
    .mockReturnValueOnce(okResponse(envelope([row()])))
  render(<JobsPage />)
  const retry = await screen.findByRole('button', { name: /retry/i })
  await userEvent.click(retry)
  expect(await screen.findByText('RHEO-0001')).toBeInTheDocument()
  expect(global.fetch).toHaveBeenCalledTimes(2)
})

// 9 ───────────────────────────────────────────────────────────────────────
test('never crashes on contract drift — alien shape renders the empty state', async () => {
  setAuthCookie()
  ;(global.fetch as jest.Mock).mockReturnValue(
    okResponse({ success: true, data: 'not-an-array', meta: { weird: true } })
  )
  render(<JobsPage />)
  expect(await screen.findByText(/no jobs yet/i)).toBeInTheDocument()
  expect(document.body.textContent).not.toMatch(/NaN|undefined/)
})
