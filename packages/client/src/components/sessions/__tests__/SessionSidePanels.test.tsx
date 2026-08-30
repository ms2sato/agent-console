import { describe, it, expect, mock, beforeEach, afterEach, afterAll, spyOn } from 'bun:test';
import { screen, cleanup, waitFor, act } from '@testing-library/react';
import { renderWithRouter } from '../../../test/renderWithRouter';
import { SessionSidePanels } from '../SessionSidePanels';
import { _reset as resetWebSocket } from '../../../lib/app-websocket';
import { installMockWebSocket } from '../../../test/mock-websocket';

// Fetch-level mock (testing.md Anti-Pattern #2: mock at the fetch boundary).
// Unlike the sibling panel test files (which each exercise one panel and one
// query), this file renders all three panels through the real container, so
// three concurrent queries land on the same mock and must be routed by URL.
const originalFetch = globalThis.fetch;
const mockFetch = mock((_input: RequestInfo | URL) => Promise.resolve(new Response()));
globalThis.fetch = Object.assign(mockFetch, { preconnect: () => {} }) as typeof fetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function urlToString(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

const MEMO_CONTENT = '# Hello Memo';
const ARTIFACT_TITLE = 'My Dashboard';
const BOOKMARK_TITLE = 'Example Site';

/**
 * Routes each panel's own query to the right fixture by URL substring, so
 * all three panels render actual content simultaneously rather than the
 * `null` early-return every sibling test file exercises for a single panel
 * in isolation. `SessionArtifactsPanel`/`SessionBookmarksPanel`'s toggle
 * buttons only render at all once their list has resolved, so a panel stuck
 * on the shared `new Response()` default would make this file's assertions
 * vacuous.
 */
function routeFetchByPanel(): void {
  mockFetch.mockImplementation((input: RequestInfo | URL) => {
    const url = urlToString(input);
    if (url.includes('/memo')) {
      return Promise.resolve(jsonResponse({ content: MEMO_CONTENT }));
    }
    if (url.includes('/artifacts')) {
      return Promise.resolve(
        jsonResponse({
          artifacts: [
            { id: 'artifact-1', title: ARTIFACT_TITLE, createdAt: '2026-08-16T00:00:00.000Z', sizeBytes: 1234 },
          ],
        })
      );
    }
    if (url.includes('/bookmarks')) {
      return Promise.resolve(
        jsonResponse({
          bookmarks: [
            {
              id: 'bookmark-1',
              url: 'https://example.com',
              title: BOOKMARK_TITLE,
              createdAt: '2026-08-20T00:00:00.000Z',
              origin: 'user',
            },
          ],
        })
      );
    }
    return Promise.resolve(jsonResponse({}, 404));
  });
}

const STORAGE_KEY = 'agent-console:session-side-panels-expanded';

describe('SessionSidePanels', () => {
  let restoreWebSocket: () => void;
  let originalLocation: Location;
  let consoleLogSpy: ReturnType<typeof spyOn>;
  let consoleErrorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    localStorage.clear();
    mockFetch.mockReset();
    routeFetchByPanel();

    // MemoPanel calls useAppWsEvent unconditionally -- mock the WebSocket so
    // it doesn't attempt a real connection during this render.
    originalLocation = window.location;
    restoreWebSocket = installMockWebSocket();
    Object.defineProperty(window, 'location', {
      value: { protocol: 'http:', host: 'localhost:3000' },
      writable: true,
    });
    consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
    resetWebSocket();
  });

  afterEach(() => {
    cleanup();
    restoreWebSocket();
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
    });
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('starts with all three sections collapsed on first render (empty localStorage, R3 default)', async () => {
    await renderWithRouter(<SessionSidePanels sessionId="session-1" />);

    await waitFor(() => expect(screen.getByLabelText('Expand memo')).toBeTruthy());
    expect(screen.getByLabelText('Expand artifacts')).toBeTruthy();
    expect(screen.getByLabelText('Expand bookmarks')).toBeTruthy();

    expect(screen.queryByText('Hello Memo')).toBeNull();
    expect(screen.queryByText(ARTIFACT_TITLE)).toBeNull();
    // The bookmarks panel is reachable even collapsed via a different route
    // (there is no separate "collapsed" query for it), so absence of its
    // list content is the right check here, same as the other two.
    expect(screen.queryByText(BOOKMARK_TITLE)).toBeNull();
  });

  it('expanding memo renders its content while artifacts/bookmarks stay collapsed (cross-component slice isolation)', async () => {
    await renderWithRouter(<SessionSidePanels sessionId="session-1" />);
    await waitFor(() => expect(screen.getByLabelText('Expand memo')).toBeTruthy());

    act(() => {
      screen.getByLabelText('Expand memo').click();
    });

    await waitFor(() => expect(screen.getByText('Hello Memo')).toBeTruthy());

    // The other two sections did not react to memo's toggle: still showing
    // their own "Expand ..." strip, and their content still absent.
    expect(screen.getByLabelText('Expand artifacts')).toBeTruthy();
    expect(screen.getByLabelText('Expand bookmarks')).toBeTruthy();
    expect(screen.queryByText(ARTIFACT_TITLE)).toBeNull();
    expect(screen.queryByText(BOOKMARK_TITLE)).toBeNull();

    // The toggle was also persisted to the single shared record -- proof
    // this test drove the real hook, not a stub.
    expect(localStorage.getItem(STORAGE_KEY)).toBe(
      JSON.stringify({ memo: true, artifacts: false, bookmarks: false })
    );
  });

  it('expanding memo and then artifacts renders both simultaneously (multi-open through the real container)', async () => {
    await renderWithRouter(<SessionSidePanels sessionId="session-1" />);
    await waitFor(() => expect(screen.getByLabelText('Expand memo')).toBeTruthy());

    act(() => {
      screen.getByLabelText('Expand memo').click();
    });
    await waitFor(() => expect(screen.getByText('Hello Memo')).toBeTruthy());

    act(() => {
      screen.getByLabelText('Expand artifacts').click();
    });
    await waitFor(() => expect(screen.getByText(ARTIFACT_TITLE)).toBeTruthy());

    // Both are on screen at once; bookmarks remains untouched.
    expect(screen.getByText('Hello Memo')).toBeTruthy();
    expect(screen.getByText(ARTIFACT_TITLE)).toBeTruthy();
    expect(screen.getByLabelText('Expand bookmarks')).toBeTruthy();
    expect(screen.queryByText(BOOKMARK_TITLE)).toBeNull();

    expect(localStorage.getItem(STORAGE_KEY)).toBe(
      JSON.stringify({ memo: true, artifacts: true, bookmarks: false })
    );
  });

  it('renders exactly one bordered rail element when all sections are collapsed (R1b/R1d DOM pin)', async () => {
    const { container } = await renderWithRouter(<SessionSidePanels sessionId="session-1" />);
    await waitFor(() => expect(screen.getByLabelText('Expand memo')).toBeTruthy());

    // The defect this pin exists to catch: each panel used to render its
    // own `border-l` strip when collapsed, producing three separate rails
    // instead of one. Only the container may own a `border-l`.
    const railElements = container.querySelectorAll('[class*="border-l"]');
    expect(railElements.length).toBe(1);
  });

  it('still renders exactly one bordered rail element once a section is expanded (R1c DOM pin)', async () => {
    const { container } = await renderWithRouter(<SessionSidePanels sessionId="session-1" />);
    await waitFor(() => expect(screen.getByLabelText('Expand memo')).toBeTruthy());

    act(() => {
      screen.getByLabelText('Expand memo').click();
    });
    await waitFor(() => expect(screen.getByText('Hello Memo')).toBeTruthy());

    // Sections inside the widened accordion separate with border-b only --
    // still exactly one border-l on the page, now on the widened column.
    const railElements = container.querySelectorAll('[class*="border-l"]');
    expect(railElements.length).toBe(1);
  });
});
