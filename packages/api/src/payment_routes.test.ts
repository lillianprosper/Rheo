/**
 * Rheo API — Flutterwave webhook: charge.completed integration tests
 * Place at: packages/api/src/payment_routes.test.ts
 *
 * Pins the three behaviours the 2026-07-20 security audit exposed:
 *   1. verifyTransaction is called with (id, amount, currency) — the
 *      expected values, so amount-tampering detection actually runs.
 *   2. A verification mismatch (thrown AppError) flags the transaction
 *      for review and does NOT complete it.
 *   3. A genuinely successful, matching charge completes the transaction
 *      (proving the old `.data?.status` return-shape bug is gone).
 *
 * These are the FIRST automated tests in packages/api. The bug class they
 * guard (caller/callee data-shape disagreement) shipped to production three
 * times; this file is the tripwire.
 */

// ── Mock every external dependency of the module under test ──────────────────
const mockVerifyTransaction = jest.fn()
const mockQuery = jest.fn()
const mockQueryOne = jest.fn()
const mockWithTransaction = jest.fn()

jest.mock('./services/flutterwave.service', () => ({
  verifyTransaction: (...a: unknown[]) => mockVerifyTransaction(...a),
  verifyWebhookSignature: jest.fn(),
  chargeMobileMoney: jest.fn(),
  initiateCardPayment: jest.fn(),
  initiateTransfer: jest.fn(),
  getAccountBank: jest.fn(),
}))
jest.mock('./config/database', () => ({
  query: (...a: unknown[]) => mockQuery(...a),
  queryOne: (...a: unknown[]) => mockQueryOne(...a),
  withTransaction: (fn: (c: unknown) => unknown) => mockWithTransaction(fn),
}))
jest.mock('./utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }))
jest.mock('./utils/audit', () => ({ auditLog: jest.fn() }))
jest.mock('./services/notification.service', () => ({ sendNotification: jest.fn() }))
jest.mock('./services/email.service', () => ({ sendEmail: jest.fn() }))
jest.mock('./utils/encryption', () => ({ decrypt: jest.fn(), generateToken: jest.fn() }))
jest.mock('./middleware/rbac', () => ({
  requireBusiness: (_req, _res, next) => next(),
  requireStaff: (_req, _res, next) => next(),
  requirePermission: () => (_req, _res, next) => next(),
}))

import { handleChargeCompleted } from './payment_routes'

// A minimal AppError shape carrying a .code, as verifyTransaction throws.
class FakeAppError extends Error {
  code: string
  constructor(message: string, code: string) { super(message); this.code = code }
}

const chargeData = (over: Record<string, unknown> = {}) => ({
  id: 288200,
  tx_ref: 'SUB-abc-123',
  status: 'successful',
  amount: 60000,
  currency: 'UGX',
  flw_ref: 'FLW-REF-9',
  ...over,
})

beforeEach(() => {
  jest.clearAllMocks()
  mockWithTransaction.mockImplementation(async (fn) => fn({ query: jest.fn().mockResolvedValue({ rows: [] }) }))
  mockQueryOne.mockResolvedValue(null) // default: no matching tx row (stops early after verify)
})

// 1 ─────────────────────────────────────────────────────────────────────────
test('calls verifyTransaction with id, expected amount, and expected currency', async () => {
  mockVerifyTransaction.mockResolvedValue({ status: 'successful', amount: 60000, currency: 'UGX' })
  await handleChargeCompleted(chargeData())
  expect(mockVerifyTransaction).toHaveBeenCalledWith(288200, 60000, 'UGX')
})

// 2 ─────────────────────────────────────────────────────────────────────────
test('reads verification.status directly (flat shape) and proceeds when successful', async () => {
  mockVerifyTransaction.mockResolvedValue({ status: 'successful', amount: 60000, currency: 'UGX' })
  mockQueryOne.mockResolvedValue({ id: 'tx1', type: 'subscription_charge', business_id: 'biz1', description: 'starter monthly' })
  await handleChargeCompleted(chargeData())
  // reached the completion transaction => proves .status read worked
  expect(mockWithTransaction).toHaveBeenCalledTimes(1)
})

// 3 ─────────────────────────────────────────────────────────────────────────
test('a thrown amount-mismatch flags the transaction for review and does NOT complete it', async () => {
  mockVerifyTransaction.mockRejectedValue(new FakeAppError('amount mismatch', 'PAYMENT_AMOUNT_MISMATCH'))
  await handleChargeCompleted(chargeData({ amount: 5 })) // attacker-tampered low amount
  // flagged_for_review UPDATE fired...
  const flagged = mockQuery.mock.calls.find(([sql]) => String(sql).includes('flagged_for_review'))
  expect(flagged).toBeTruthy()
  // ...and completion never ran
  expect(mockWithTransaction).not.toHaveBeenCalled()
})

// 4 ─────────────────────────────────────────────────────────────────────────
test('a non-successful webhook status marks the transaction failed without verifying', async () => {
  await handleChargeCompleted(chargeData({ status: 'failed' }))
  const failed = mockQuery.mock.calls.find(([sql]) => String(sql).includes("status = 'failed'"))
  expect(failed).toBeTruthy()
  expect(mockVerifyTransaction).not.toHaveBeenCalled()
})

// 5 ─────────────────────────────────────────────────────────────────────────
test('verified-but-not-successful status returns early without completing', async () => {
  mockVerifyTransaction.mockResolvedValue({ status: 'pending', amount: 60000, currency: 'UGX' })
  await handleChargeCompleted(chargeData())
  expect(mockWithTransaction).not.toHaveBeenCalled()
})
