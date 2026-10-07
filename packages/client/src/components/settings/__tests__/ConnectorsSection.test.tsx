/**
 * Fetch-level mocking (not `mock.module()`, which is process-global in
 * bun:test and would leak into other test files) -- see
 * `NotificationBell.test.tsx` for the same pattern. A tiny stateful fake
 * server stands in for `GET /api/auth/me` and `PATCH
 * /api/auth/me/preferences`, so the component's own TanStack Query read +
 * mutation wiring is exercised end to end rather than asserted from memory
 * of the implementation.
 */
import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { screen, cleanup, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { renderWithRouter } from '../../../test/renderWithRouter';
import { ConnectorsSection } from '../ConnectorsSection';

const originalFetch = globalThis.fetch;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const currentUser = { id: 'user-1', username: 'alice', homeDir: '/home/alice' };

let hasPreferences = true;
let disableClaudeAiConnectors = false;
/** When set, the GET /me handler blocks until this resolver is invoked -- lets a test observe the loading state deterministically. */
let blockGet = false;
let resolveGet: (() => void) | null = null;
/** When set, the PATCH handler blocks until this resolver is invoked -- lets a test observe the mutation's pending state deterministically. */
let blockPatch = false;
let resolvePatch: (() => void) | null = null;
/** When set, the PATCH handler responds with `patchFailStatus` instead of succeeding -- exercises the same `handleApiError` rejection path for any non-2xx status, including the 404 the server now returns for a missing user row. */
let patchShouldFail = false;
let patchFailStatus = 500;

const mockFetch = mock(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = input instanceof Request ? input.url : String(input);
  const method = (input instanceof Request ? input.method : init?.method) ?? 'GET';

  if (url.includes('/auth/me/preferences') && method === 'PATCH') {
    if (blockPatch) {
      await new Promise<void>((resolve) => {
        resolvePatch = resolve;
      });
    }
    if (patchShouldFail) {
      return jsonResponse({ error: 'Failed to update preferences' }, patchFailStatus);
    }
    const rawBody = input instanceof Request ? await input.text() : (init?.body as string | undefined);
    const parsed = rawBody ? (JSON.parse(rawBody) as { disableClaudeAiConnectors: boolean }) : null;
    if (parsed) disableClaudeAiConnectors = parsed.disableClaudeAiConnectors;
    return jsonResponse({
      user: currentUser,
      preferences: { disableClaudeAiConnectors },
    });
  }

  if (url.includes('/auth/me') && method === 'GET') {
    if (blockGet) {
      await new Promise<void>((resolve) => {
        resolveGet = resolve;
      });
    }
    return jsonResponse({
      user: hasPreferences ? currentUser : null,
      preferences: hasPreferences ? { disableClaudeAiConnectors } : undefined,
    });
  }

  return jsonResponse({});
});

beforeEach(() => {
  const fetchStub: typeof fetch = Object.assign(mockFetch, { preconnect: () => {} });
  globalThis.fetch = fetchStub;
  mockFetch.mockClear();
  hasPreferences = true;
  disableClaudeAiConnectors = false;
  blockGet = false;
  resolveGet = null;
  blockPatch = false;
  resolvePatch = null;
  patchShouldFail = false;
  patchFailStatus = 500;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  // Release any still-blocked GET/PATCH so its pending promise doesn't leak
  // into the next test's process-wide microtask queue.
  resolveGet?.();
  resolvePatch?.();
});

describe('ConnectorsSection', () => {
  it('renders the checkbox unchecked when the preference is false', async () => {
    disableClaudeAiConnectors = false;
    await renderWithRouter(<ConnectorsSection />);

    await waitFor(() => expect(screen.getByRole('checkbox')).toBeTruthy());
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  });

  it('renders the checkbox checked when the preference is true', async () => {
    disableClaudeAiConnectors = true;
    await renderWithRouter(<ConnectorsSection />);

    await waitFor(() => expect(screen.getByRole('checkbox')).toBeTruthy());
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
  });

  it('renders nothing when /me returns user: null (unauthenticated)', async () => {
    hasPreferences = false;
    await renderWithRouter(<ConnectorsSection />);

    await waitFor(() => expect(mockFetch.mock.calls.length).toBeGreaterThan(0));
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('renders nothing while the query is loading', async () => {
    blockGet = true;
    await renderWithRouter(<ConnectorsSection />);

    await waitFor(() => expect(mockFetch.mock.calls.length).toBeGreaterThan(0));
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('clicking the checkbox PATCHes the flipped value and reflects the new checked state', async () => {
    disableClaudeAiConnectors = false;
    await renderWithRouter(<ConnectorsSection />);

    await waitFor(() => expect(screen.getByRole('checkbox')).toBeTruthy());
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);

    const user = userEvent.setup();
    await user.click(screen.getByRole('checkbox'));

    await waitFor(() => expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true));

    const patchCall = mockFetch.mock.calls.find(([input, init]) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = (input instanceof Request ? input.method : init?.method) ?? 'GET';
      return url.includes('/auth/me/preferences') && method === 'PATCH';
    });
    expect(patchCall).toBeTruthy();
    const [patchInput, patchInit] = patchCall!;
    const rawBody =
      patchInput instanceof Request ? await patchInput.clone().text() : (patchInit?.body as string);
    expect(JSON.parse(rawBody)).toEqual({ disableClaudeAiConnectors: true });
  });

  it('disables the checkbox while a PATCH is in flight, and re-enables it once settled', async () => {
    blockPatch = true;
    await renderWithRouter(<ConnectorsSection />);

    await waitFor(() => expect(screen.getByRole('checkbox')).toBeTruthy());
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(false);

    const user = userEvent.setup();
    await user.click(screen.getByRole('checkbox'));

    await waitFor(() => expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true));

    resolvePatch?.();

    await waitFor(() => expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(false));
  });

  it('renders an error line when the PATCH mutation rejects (server error)', async () => {
    patchShouldFail = true;
    patchFailStatus = 500;
    await renderWithRouter(<ConnectorsSection />);

    await waitFor(() => expect(screen.getByRole('checkbox')).toBeTruthy());
    expect(screen.queryByText(/Failed to update the connectors preference/i)).toBeNull();

    const user = userEvent.setup();
    await user.click(screen.getByRole('checkbox'));

    await waitFor(() => expect(screen.getByText(/Failed to update the connectors preference/i)).toBeTruthy());
    // The mutation never succeeded, so the cache (and thus the displayed
    // checked state) is unchanged, and the checkbox is re-enabled again.
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(false);
  });

  it('renders the same error line for a 404 response as for any other failure (the missing-user-row case)', async () => {
    patchShouldFail = true;
    patchFailStatus = 404;
    await renderWithRouter(<ConnectorsSection />);

    await waitFor(() => expect(screen.getByRole('checkbox')).toBeTruthy());

    const user = userEvent.setup();
    await user.click(screen.getByRole('checkbox'));

    // A 404 is a non-ok response like any other; `handleApiError` (called
    // unconditionally on `!res.ok`, with no 404-specific branch in
    // `updateAuthPreferences`) rejects the mutation the same way a network
    // or 500 failure would, so the same error line fires here too.
    await waitFor(() => expect(screen.getByText(/Failed to update the connectors preference/i)).toBeTruthy());
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  });
});
