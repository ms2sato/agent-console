import { waitFor } from '@testing-library/react';

/**
 * Measured cause (Issue 1899, bun 1.3.14 + happy-dom 20.0.11): inside a
 * `waitFor` callback, `expect(el).toBeNull()` on a real happy-dom element is
 * extremely slow on every FAILING poll, because bun:test's failure-message
 * construction serializes the happy-dom element -- not because the query
 * itself (`queryByRole` / `queryByText` / `querySelector`) is slow. Measured
 * on a 4-tab-bar fixture: `expect(el).toBeNull()` cost ~5.9s elapsed and
 * +580MB heap per close operation; the identical query compared as
 * `query() !== null` (a throw, nothing to serialize) cost ~60ms and ~0MB.
 * See Issue 1899's body for the full measurement ledger.
 *
 * This helper avoids ever handing a DOM element to `expect(...)` inside the
 * polled callback: it throws a plain `Error` instead, so a failing poll's
 * message has nothing happy-dom-shaped to serialize.
 */
export function waitForAbsent(
  query: () => Element | null,
  options?: Parameters<typeof waitFor>[1],
): Promise<void> {
  return waitFor(() => {
    if (query() !== null) {
      throw new Error('element still present');
    }
  }, options);
}
