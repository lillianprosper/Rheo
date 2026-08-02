/**
 * Rheo Admin — KYC Review Queue tests (contract-verified edition)
 * Place at: apps/admin/src/app/dashboard/kyc/page.test.tsx
 *
 * The mock payload below mirrors the LIVE API contract from admin.routes.ts:
 *   GET /admin/kyc/queue?type=driver → { data: { type, queue: [...] } }
 *   POST /admin/kyc/driver/:id/review { action, notes? } → { data: {...} }
 *
 * These tests pin the behaviours that matter for driver activation:
 *   1. pending drivers render
 *   2. approve calls the review endpoint with action:'approve' and drops the row
 *   3. reject sends the typed notes
 *   4. an empty queue shows the "clear" state
 *   5. a 401 on load redirects to /login (auth gate honoured)
 *   6. contract drift (missing fields) renders without crashing
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import KycQueuePage from './page'
import { redirectToLogin } from '../navigation'

jest.mock('../navigation', () => ({ redirectToLogin: jest.fn() }))

function setAuthCookie() {
  document.cookie = 'rheo_access=test-token;Path=/'
}
function clearAuthCookie() {
  document.cookie = 'rheo_access=;Path=/;Expires=Thu, 01 Jan 1970 00:00:00 GMT'
}

const DRIVER_A = {
  id: 'drv-1', first_name: 'Julian', last_name: 'Testdriver',
  phone: '+256770000001', email: 'driver-test@rheoug.com',
  status: 'pending', kyc_status: 'submitted',
  vehicle_type: 'motorcycle', plate_number: 'UAX 123A',
  created_at: new Date(Date.now() - 3600_000).toISOString(), doc_count: 2,
}
const DRIVER_B = {
  id: 'drv-2', first_name: 'Amina', last_name: 'Nakato',
  phone: '+256770000002', email: 'amina@example.com',
  status: 'pending', kyc_status: 'submitted',
  vehicle_type: 'car', plate_number: 'UBB 456B',
  created_at: new Date(Date.now() - 7200_000).toISOString(), doc_count: 3,
}

function mockQueue(queue: unknown[]) {
  return Promise.resolve({
    ok: true, status: 200,
    json: () => Promise.resolve({ success: true, data: { type: 'driver', queue } }),
  }) as unknown as Promise<Response>
}
function mockReviewOk() {
  return Promise.resolve({
    ok: true, status: 200,
    json: () => Promise.resolve({ success: true, data: { kycStatus: 'approved', documents: [] } }),
  }) as unknown as Promise<Response>
}

beforeEach(() => {
  jest.clearAllMocks()
  setAuthCookie()
})
afterEach(() => clearAuthCookie())

test('renders pending drivers from the queue', async () => {
  global.fetch = jest.fn().mockReturnValueOnce(mockQueue([DRIVER_A, DRIVER_B]))
  render(<KycQueuePage />)
  expect(await screen.findByText('Julian Testdriver')).toBeInTheDocument()
  expect(screen.getByText('Amina Nakato')).toBeInTheDocument()
  expect(screen.getByText('UAX 123A')).toBeInTheDocument()
})

test('approve posts action:approve and removes the row', async () => {
  const fetchMock = jest.fn()
    .mockReturnValueOnce(mockQueue([DRIVER_A]))
    .mockReturnValueOnce(mockReviewOk())
  global.fetch = fetchMock

  render(<KycQueuePage />)
  const row = (await screen.findByText('Julian Testdriver')).closest('tr')!
  await userEvent.click(within(row).getByText('Approve'))

  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  // Second call = the review POST
  const [url, opts] = fetchMock.mock.calls[1]
  expect(String(url)).toContain('/admin/kyc/driver/drv-1/review')
  expect(opts.method).toBe('POST')
  expect(JSON.parse(opts.body)).toEqual({ action: 'approve' })

  // Row is gone, success banner shows
  await waitFor(() => {
    expect(screen.queryByText('Julian Testdriver')).not.toBeInTheDocument()
  })
  expect(screen.getByText(/approved and activated/i)).toBeInTheDocument()
})

test('reject sends the typed notes', async () => {
  const fetchMock = jest.fn()
    .mockReturnValueOnce(mockQueue([DRIVER_A]))
    .mockReturnValueOnce(mockReviewOk())
  global.fetch = fetchMock

  render(<KycQueuePage />)
  const row = (await screen.findByText('Julian Testdriver')).closest('tr')!
  await userEvent.click(within(row).getByText('Reject'))

  const input = await within(row).findByLabelText(/reason for rejecting/i)
  await userEvent.type(input, 'Blurry ID photo')
  await userEvent.click(within(row).getByText('Confirm reject'))

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
  const [, opts] = fetchMock.mock.calls[1]
  expect(JSON.parse(opts.body)).toEqual({ action: 'reject', notes: 'Blurry ID photo' })
})

test('empty queue shows the cleared state', async () => {
  global.fetch = jest.fn().mockReturnValueOnce(mockQueue([]))
  render(<KycQueuePage />)
  expect(await screen.findByText(/queue is clear/i)).toBeInTheDocument()
})

test('a 401 on load redirects to login', async () => {
  global.fetch = jest.fn().mockReturnValueOnce(
    Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) }) as unknown as Promise<Response>
  )
  render(<KycQueuePage />)
  await waitFor(() => expect(redirectToLogin).toHaveBeenCalled())
})

test('contract drift (missing fields) renders without crashing', async () => {
  global.fetch = jest.fn().mockReturnValueOnce(mockQueue([{ id: 'drv-x' }]))
  render(<KycQueuePage />)
  expect(await screen.findByText('Driver KYC Review')).toBeInTheDocument()
  await waitFor(() => {
    expect(screen.queryByText(/loading review queue/i)).not.toBeInTheDocument()
  })
})

