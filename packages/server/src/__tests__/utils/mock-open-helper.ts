/**
 * Centralized `open` package mock for tests.
 *
 * IMPORTANT: Import this module (for its side effects) in any file that
 * needs the `open` npm package mocked. The mock.module call is executed
 * once when this module is first imported.
 *
 * Kept in its own file (sibling to mock-fs-helper.ts, mock-process-helper.ts,
 * mock-git-helper.ts) rather than inline in test-utils.ts so a consumer that
 * only needs `open` mocked -- notably packages/integration/src/setup.ts's
 * preload, which must register this before any test file's own import graph
 * can bind routes/system.ts's `open` import to the real package -- does not
 * have to pull in every other test-utils.ts mock as a side effect.
 */
import { mock } from 'bun:test';

export const mockOpen = mock(async () => {});
mock.module('open', () => ({
  default: mockOpen,
}));
