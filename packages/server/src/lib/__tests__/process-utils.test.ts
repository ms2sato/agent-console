import { describe, it, expect, spyOn } from 'bun:test';

/**
 * `mock-process-helper.ts` (used by several service tests, e.g.
 * `session-initialization-service.test.ts`) registers a process-global
 * `mock.module()` override for this exact file's resolved absolute path
 * (see `.claude/rules/testing.md` Anti-Pattern #2: "mock.module() is
 * process-global in bun:test and pollutes all test files in the same
 * process"). When the full suite runs in one `bun test` invocation, a
 * plain `import { isProcessAlive } from '../process-utils.js'` here would
 * resolve to that OTHER file's fake (`alivePids.has(pid)`), not the real
 * implementation under test -- silently defeating every assertion below
 * regardless of the `process.kill` spy.
 *
 * A dynamic `import()` with a distinguishing query string resolves to a
 * fresh module specifier that `mock.module()`'s exact-path registration
 * does not match, so it always loads the real, unmocked module. Verified
 * empirically: this suite passes in isolation AND alongside
 * `session-initialization-service.test.ts` in the same invocation.
 */
let loadCounter = 0;
async function loadRealProcessUtils(): Promise<typeof import('../process-utils.js')> {
  // Template literal (not a string literal) so TypeScript treats the
  // specifier as dynamic and does not attempt static module resolution on
  // the query-string suffix; the explicit return type annotation above
  // still gives callers the real module's typed shape.
  return import(`../process-utils.js?real-impl-under-test=${++loadCounter}`);
}

function makeErrno(code: string): NodeJS.ErrnoException {
  const err = new Error(`mock process.kill error: ${code}`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

describe('isProcessAlive', () => {
  it('returns true when process.kill succeeds', async () => {
    const { isProcessAlive } = await loadRealProcessUtils();
    const spy = spyOn(process, 'kill').mockImplementation(() => true);
    try {
      expect(isProcessAlive(12345)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('returns false when process.kill throws ESRCH (no such process)', async () => {
    const { isProcessAlive } = await loadRealProcessUtils();
    const spy = spyOn(process, 'kill').mockImplementation(() => {
      throw makeErrno('ESRCH');
    });
    try {
      expect(isProcessAlive(12345)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('returns true when process.kill throws EPERM (process exists, owned by another user)', async () => {
    const { isProcessAlive } = await loadRealProcessUtils();
    const spy = spyOn(process, 'kill').mockImplementation(() => {
      throw makeErrno('EPERM');
    });
    try {
      expect(isProcessAlive(12345)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('returns true (fail-safe default) when process.kill throws an unexpected error code', async () => {
    const { isProcessAlive } = await loadRealProcessUtils();
    const spy = spyOn(process, 'kill').mockImplementation(() => {
      throw makeErrno('EINVAL');
    });
    try {
      expect(isProcessAlive(12345)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
