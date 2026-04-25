module.exports = {
  testEnvironment: 'node',
  collectCoverageFrom: [
    'core/**/*.js',
    '!core/**/node_modules/**'
  ],
  testMatch: [
    '**/test/**/*.test.js'
  ],
  verbose: true,
  testTimeout: 30000,
  moduleNameMapper: {
    '^electron$': '<rootDir>/test/__mocks__/electron.js'
  }
};