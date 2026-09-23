/**
 * The application is native ESM, so Jest runs through Node's VM modules rather
 * than a transform. No Babel step: the tests import the same files the server
 * does, which is the point of testing them at this level.
 */
export default {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],

  // Unit tests only. These must not reach the database — a pure function that
  // needs a connection to be verified is not a pure function.
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/app.js',
    '!src/routes/**'
  ],

  // 'text' prints the per-file table: a single global percentage hides which
  // modules are actually covered and which are only counted in the denominator.
  coverageReporters: ['text', 'text-summary', 'lcov'],
  clearMocks: true
};
