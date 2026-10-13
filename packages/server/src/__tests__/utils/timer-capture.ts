import { spyOn } from 'bun:test';

/**
 * Observe the timer a piece of code creates and whether that exact timer is
 * cleared.
 *
 * Only `setTimeout` calls made during the SYNCHRONOUS part of `run()` are
 * recorded, so timers created elsewhere in the process while the test awaits
 * (other test files share one `bun test` process) cannot be mistaken for the
 * code under test. The assertion a caller builds on the result is therefore
 * "the handle created during the call was cleared", never "the global
 * `clearTimeout` call count was N".
 *
 * `delays` holds the delay argument of each recorded `setTimeout` call, for
 * pinning a default timeout value without waiting for it.
 */
export async function timerClearedAfter(
  run: () => Promise<unknown>,
): Promise<{ created: unknown[]; cleared: unknown[]; delays: unknown[] }> {
  const created: unknown[] = [];
  const cleared: unknown[] = [];
  const delays: unknown[] = [];
  let recording = true;
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const setSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((...args: Parameters<typeof setTimeout>) => {
    const handle = realSet(...args);
    if (recording) {
      created.push(handle);
      delays.push(args[1]);
    }
    return handle;
  }) as typeof setTimeout);
  const clearSpy = spyOn(globalThis, 'clearTimeout').mockImplementation(((handle?: Parameters<typeof clearTimeout>[0]) => {
    cleared.push(handle);
    return realClear(handle);
  }) as typeof clearTimeout);
  try {
    const pending = run();
    recording = false;
    await pending;
  } finally {
    setSpy.mockRestore();
    clearSpy.mockRestore();
  }
  return { created, cleared, delays };
}
