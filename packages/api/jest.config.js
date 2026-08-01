/**
 * Jest config for packages/api — place at: packages/api/jest.config.js
 * First test runner in the API package (security-audit follow-up).
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/*.test.ts'],
  clearMocks: true,
}
