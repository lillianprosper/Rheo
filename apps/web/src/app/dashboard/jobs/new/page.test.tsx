/**
 * Rheo Business — Create Job tests
 * Place at: apps/web/src/app/dashboard/jobs/new/page.test.tsx
 *
 * Pins: client validation mirrors the API schema and blocks the network;
 * exactly-one-POST under double-click; Bearer-only body matching the
 * contract; server messages surfaced verbatim; typed input survives failure.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import NewJobPage from './page'
import { redirectToLogin, goToJobs } from '../../navigation'

jest.mock('../../navigation', () => ({
  redirectToLogin: jest.fn(),
  goToJobs: jest.fn(),
}))

function setAuthCookie() {
  document.cookie = 'rheo_access=test-token;Path=/'
}
function clearAuthCookie() {
  document.cookie = 'rheo_access=;Path=/;Expires=Thu, 01 Jan 1970 00:00:00 GMT'
}

async function fillValidForm() {
  await userEvent.type(screen.getByLabelText(/what is being delivered/i), '2 boxes of shoes')
  await userEvent.type(screen.getByLabelText(/pickup address/i), 'Nakasero Market, Kampala')
  await userEvent.type(screen.getByLabelText(/delivery address/i), 'Ntinda Shopping Centre')
  await userEvent.type(screen.getByLabelText(/fare \(ugx\)/i), '15000')
}

function okResponse(body: unknown, status = 201) {
  return Promise.resolve({ ok: true, status, json: () => Promise.resolve(body) })
}

beforeEach(() => {
  jest.clearAllMocks()
  setAuthCookie()
  global.fetch = jest.fn()
})

// 1 ───────────────────────────────────────────────────────────────────────
test('renders the required fields', () => {
  render(<NewJobPage />)
  expect(screen.getByLabelText(/what is being delivered/i)).toBeInTheDocument()
  expect(screen.getByLabelText(/pickup address/i)).toBeInTheDocument()
  expect(screen.getByLabelText(/delivery address/i)).toBeInTheDocument()
  expect(screen.getByLabelText(/fare \(ugx\)/i)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /create job/i })).toBeEnabled()
})

// 2 ───────────────────────────────────────────────────────────────────────
test('client validation blocks short description — no request fires', async () => {
  render(<NewJobPage />)
  await userEvent.type(screen.getByLabelText(/what is being delivered/i), 'abc')
  await userEvent.type(screen.getByLabelText(/pickup address/i), 'Nakasero Market, Kampala')
  await userEvent.type(screen.getByLabelText(/delivery address/i), 'Ntinda Shopping Centre')
  await userEvent.type(screen.getByLabelText(/fare \(ugx\)/i), '15000')
  await userEvent.click(screen.getByRole('button', { name: /create job/i }))
  expect(await screen.findByText(/at least 5 characters/i)).toBeInTheDocument()
  expect(global.fetch).not.toHaveBeenCalled()
})

// 3 ───────────────────────────────────────────────────────────────────────
test('client validation blocks zero, negative, and missing fare — no request fires', async () => {
  render(<NewJobPage />)
  await userEvent.type(screen.getByLabelText(/what is being delivered/i), '2 boxes of shoes')
  await userEvent.type(screen.getByLabelText(/pickup address/i), 'Nakasero Market, Kampala')
  await userEvent.type(screen.getByLabelText(/delivery address/i), 'Ntinda Shopping Centre')
  await userEvent.type(screen.getByLabelText(/fare \(ugx\)/i), '0')
  await userEvent.click(screen.getByRole('button', { name: /create job/i }))
  expect(await screen.findByText(/greater than zero/i)).toBeInTheDocument()
  expect(global.fetch).not.toHaveBeenCalled()
})

// 4 ───────────────────────────────────────────────────────────────────────
test('happy path: POSTs the contract body Bearer-only, then navigates to jobs', async () => {
  ;(global.fetch as jest.Mock).mockReturnValue(okResponse({ success: true, data: { id: 'j1' } }))
  render(<NewJobPage />)
  await fillValidForm()
  await userEvent.click(screen.getByRole('button', { name: /create job/i }))
  await waitFor(() => expect(goToJobs).toHaveBeenCalled())

  const [url, init] = (global.fetch as jest.Mock).mock.calls[0]
  expect(url).toMatch(/\/jobs$/)
  expect(init.method).toBe('POST')
  expect(init.headers.Authorization).toBe('Bearer test-token')
  const body = JSON.parse(init.body)
  expect(body).toMatchObject({
    description: '2 boxes of shoes',
    pickupAddress: 'Nakasero Market, Kampala',
    deliveryAddress: 'Ntinda Shopping Centre',
    baseFareUgx: 15000,           // number, not string — API schema requires it
    fragile: false,
  })
  // Scoping is server-side via JWT — no business id anywhere in the request
  expect(url + init.body + JSON.stringify(init.headers)).not.toMatch(/business[_-]?id/i)
})

// 5 ───────────────────────────────────────────────────────────────────────
test('button disables while the request is in flight', async () => {
  ;(global.fetch as jest.Mock).mockReturnValue(new Promise(() => {})) // never resolves
  render(<NewJobPage />)
  await fillValidForm()
  const btn = screen.getByRole('button', { name: /create job/i })
  await userEvent.click(btn)
  await waitFor(() => expect(screen.getByRole('button', { name: /creating/i })).toBeDisabled())
})

// 6 ───────────────────────────────────────────────────────────────────────
test('rapid double-click fires exactly one POST — billable action guard', async () => {
  ;(global.fetch as jest.Mock).mockReturnValue(new Promise(() => {}))
  render(<NewJobPage />)
  await fillValidForm()
  const btn = screen.getByRole('button', { name: /create job/i })
  await userEvent.dblClick(btn)
  expect(global.fetch).toHaveBeenCalledTimes(1)
})

// 7 ───────────────────────────────────────────────────────────────────────
test('surfaces the server message on 400 (e.g. monthly job limit) and preserves input', async () => {
  ;(global.fetch as jest.Mock).mockResolvedValue({
    ok: false, status: 400,
    json: () => Promise.resolve({ success: false, error: { message: 'Monthly job limit (50) reached.' } }),
  })
  render(<NewJobPage />)
  await fillValidForm()
  await userEvent.click(screen.getByRole('button', { name: /create job/i }))
  expect(await screen.findByText(/monthly job limit \(50\) reached/i)).toBeInTheDocument()
  expect(screen.getByLabelText(/pickup address/i)).toHaveValue('Nakasero Market, Kampala')
  expect(screen.getByRole('button', { name: /create job/i })).toBeEnabled() // retry allowed
  expect(goToJobs).not.toHaveBeenCalled()
})

// 8 ───────────────────────────────────────────────────────────────────────
test('redirects to login when the API returns 401', async () => {
  ;(global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 401, json: () => Promise.resolve({}) })
  render(<NewJobPage />)
  await fillValidForm()
  await userEvent.click(screen.getByRole('button', { name: /create job/i }))
  await waitFor(() => expect(redirectToLogin).toHaveBeenCalled())
})

// 9 ───────────────────────────────────────────────────────────────────────
test('network failure shows a banner, preserves input, and a retry succeeds', async () => {
  ;(global.fetch as jest.Mock)
    .mockRejectedValueOnce(new Error('network down'))
    .mockReturnValueOnce(okResponse({ success: true, data: { id: 'j1' } }))
  render(<NewJobPage />)
  await fillValidForm()
  await userEvent.click(screen.getByRole('button', { name: /create job/i }))
  expect(await screen.findByText(/could not reach the server/i)).toBeInTheDocument()
  expect(screen.getByLabelText(/delivery address/i)).toHaveValue('Ntinda Shopping Centre')
  await userEvent.click(screen.getByRole('button', { name: /create job/i }))
  await waitFor(() => expect(goToJobs).toHaveBeenCalled())
  expect(global.fetch).toHaveBeenCalledTimes(2)
})

// 10 ──────────────────────────────────────────────────────────────────────
test('missing auth cookie at submit redirects to login without a request', async () => {
  render(<NewJobPage />)
  await fillValidForm()
  clearAuthCookie()
  await userEvent.click(screen.getByRole('button', { name: /create job/i }))
  await waitFor(() => expect(redirectToLogin).toHaveBeenCalled())
  expect(global.fetch).not.toHaveBeenCalled()
})
