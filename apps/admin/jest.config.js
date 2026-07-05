/**
 * Jest config for apps/admin — place at: apps/admin/jest.config.js
 * Uses next/jest so Next.js handles TS/JSX transforms automatically.
 */
const nextJest = require('next/jest')

const createJestConfig = nextJest({ dir: './' })

module.exports = createJestConfig({
  testEnvironment: 'jsdom',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
})
