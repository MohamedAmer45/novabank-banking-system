/**
 * The application is native ESM, so Jest runs through Node's VM modules rather
 * than a transform. No Babel step: the tests import the same files the server
 * does, which is the point of testing them at this level.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Stryker copies the whole project into .stryker-tmp/sandbox-XXXX to mutate it.
// If a run is interrupted the sandbox survives, and because testMatch is
// recursive Jest then finds every test twice over and reports a tripled count
// as if it were a real suite. Ignoring the directory by its absolute path is
// what makes this safe inside a sandbox as well: there __dirname *is* the
// sandbox, so the pattern points at a .stryker-tmp that does not exist and the
// mutation run still sees its own tests. A relative pattern would match the
// sandbox's own path and silently leave Stryker with nothing to run.
const rootDir = path.dirname(fileURLToPath(import.meta.url));
const strykerSandboxes =
  path.join(rootDir, '.stryker-tmp').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export default {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  testPathIgnorePatterns: ['/node_modules/', strykerSandboxes],
  modulePathIgnorePatterns: [strykerSandboxes],

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
