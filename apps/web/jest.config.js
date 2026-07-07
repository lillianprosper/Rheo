/**
 * Jest config for apps/web — place at: apps/web/jest.config.js
 * (Identical rig to apps/admin — one pattern, both apps.)
 */
const nextJest = require('next/jest')
const createJestConfig = nextJest({ dir: './' })

module.exports = createJestConfig({
  testEnvironment: 'jsdom',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
})
