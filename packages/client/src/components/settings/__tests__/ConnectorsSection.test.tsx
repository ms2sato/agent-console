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

const mockFetch = mock(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = input instanceof Request ? input.url : String(input);
  const method = (input instanceof Request ? input.method : init?.method) ?? 'GET';

  if (url.includes('/auth/me/preferences') && method === 'PATCH') {
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
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  // Release a still-blocked GET so its pending promise doesn't leak into
  // the next test's process-wide microtask queue.
  resolveGet?.();
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
});
