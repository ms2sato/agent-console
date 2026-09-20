import { describe, it, expect, mock, beforeEach, afterEach, afterAll, spyOn } from 'bun:test';
import { screen, cleanup, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

const STORAGE_KEY = 'agent-console:session-side-panels-v2';

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

  it('tabs from the collapsed Memo header through the always-visible Edit button to the Artifacts header, skipping Memo\'s inert body entirely', async () => {
    // happy-dom / user-event do not model keyboard-focusable scrollers
    // (Chrome's behavior of treating a scroll container with no focusable
    // children as a tab stop), so this test cannot reproduce the original
    // bug directly. The DOM-level pin is that Memo's AccordionSectionBody
    // wrapper carries `inert` (which removes its overflow-y-auto scroller
    // from the tab order structurally) once Memo is collapsed; the actual
    // browser behavior is verified only by the Browser QA captures
    // attached to the PR.
    //
    // Measured (not assumed): with this fixture's `routeFetchByPanel`
    // content (non-empty memo), the element immediately after the
    // collapsed Memo header in DOM/tab order is MemoPanel's own "Edit
    // memo" button -- it lives in the header row, OUTSIDE
    // AccordionSectionBody entirely, and stays reachable by design while
    // collapsed (MemoPanel.tsx: "the only section whose always-visible
    // header control (Edit) can enter a content-editing mode while the
    // section is collapsed"). So the next HEADER after Memo's is
    // Artifacts, reached on the SECOND Tab, not the first.
    //
    // This is a FIXTURE difference from the drawer's sibling test
    // (SessionSidePanelsDrawer.test.tsx), not a rail-vs-drawer difference
    // -- do not file the divergence between the two tests as a bug.
    // MemoPanel renders the Edit button in its header row only when
    // `mode === 'view' && !isEmpty` (MemoPanel.tsx ~L188). This file's
    // `routeFetchByPanel` fixture gives Memo non-empty content, so the
    // Edit button renders and is an intermediate tab stop. The drawer
    // test instead uses `routeFetchEmpty()`, under which `isEmpty` is
    // true and the Edit button never renders at all -- so that test tabs
    // directly header -> header, with nothing in between.
    await renderWithRouter(<SessionSidePanels sessionId="session-1" />);
    await waitFor(() => expect(screen.getByLabelText('Expand side panel')).toBeTruthy());

    act(() => {
      screen.getByLabelText('Expand side panel').click();
    });
    await waitFor(() => expect(screen.getByText('Hello Memo')).toBeTruthy());

    const memoHeader = screen.getByLabelText('Collapse Memo');
    const user = userEvent.setup();
    await user.click(memoHeader);
    const collapsedMemoHeader = await waitFor(() => screen.getByLabelText('Expand Memo'));
    const editMemoButton = screen.getByLabelText('Edit memo');
    const artifactsHeader = screen.getByLabelText('Collapse Artifacts');

    const memoSection = collapsedMemoHeader.closest('.border-b') as HTMLElement;
    const memoBodyWrapper = memoSection.querySelector('[aria-hidden]') as HTMLElement;
    expect(memoBodyWrapper).toBeTruthy();
    expect(memoBodyWrapper.getAttribute('inert')).toBe('');
    expect(memoSection.querySelector('.overflow-y-auto')).not.toBe(document.activeElement);

    // The click above leaves focus on the header itself -- assert that
    // before tabbing away from it.
    expect(document.activeElement).toBe(collapsedMemoHeader);

    await user.tab();
    expect(document.activeElement).toBe(editMemoButton);
    expect(memoBodyWrapper.getAttribute('inert')).toBe('');
    expect(memoSection.querySelector('.overflow-y-auto')).not.toBe(document.activeElement);

    await user.tab();
    expect(document.activeElement).toBe(artifactsHeader);
    expect(memoBodyWrapper.getAttribute('inert')).toBe('');
    expect(memoSection.querySelector('.overflow-y-auto')).not.toBe(document.activeElement);
  });

  it('starts with the rail closed (new default), then shows all three sections expanded once opened', async () => {
    await renderWithRouter(<SessionSidePanels sessionId="session-1" />);

    // New default: the rail starts closed, so the compact rail's own
    // toggle button (not the Memo content) is what's available first.
    await waitFor(() => expect(screen.getByLabelText('Expand side panel')).toBeTruthy());

    act(() => {
      screen.getByLabelText('Expand side panel').click();
    });

    await waitFor(() => expect(screen.getByText('Hello Memo')).toBeTruthy());
    expect(screen.getByText(ARTIFACT_TITLE)).toBeTruthy();
    expect(screen.getByText(BOOKMARK_TITLE)).toBeTruthy();

    expect(screen.getByLabelText('Collapse Memo').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByLabelText('Collapse Artifacts').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByLabelText('Collapse Bookmarks').getAttribute('aria-expanded')).toBe('true');
  });

  it('the rail toggle button flips between the wide and narrow rail classes', async () => {
    const { container } = await renderWithRouter(<SessionSidePanels sessionId="session-1" />);
    await waitFor(() => expect(screen.getByLabelText('Expand side panel')).toBeTruthy());

    // Starts closed (new default).
    expect(screen.getByLabelText('Expand side panel').getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.w-80')).toBeNull();

    act(() => {
      screen.getByLabelText('Expand side panel').click();
    });

    await waitFor(() => expect(screen.getByLabelText('Collapse side panel')).toBeTruthy());
    expect(screen.getByLabelText('Collapse side panel').getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.w-80')).toBeTruthy();

    act(() => {
      screen.getByLabelText('Collapse side panel').click();
    });

    await waitFor(() => expect(screen.getByLabelText('Expand side panel')).toBeTruthy());
    expect(container.querySelector('.w-80')).toBeNull();
  });

  it('clicking a compact section label while the rail is closed reopens the rail with that section expanded, without disturbing an already-expanded section (R5a)', async () => {
    await renderWithRouter(<SessionSidePanels sessionId="session-1" />);
    await waitFor(() => expect(screen.getByLabelText('Expand side panel')).toBeTruthy());

    // Open the rail first (new default is closed) to set up the
    // "artifacts collapsed, memo still expanded" starting state.
    act(() => {
      screen.getByLabelText('Expand side panel').click();
    });
    await waitFor(() => expect(screen.getByText('Hello Memo')).toBeTruthy());

    // Collapse the artifacts section (it stays collapsed once the rail
    // closes), but leave memo expanded.
    act(() => {
      screen.getByLabelText('Collapse Artifacts').click();
    });
    await waitFor(() => expect(screen.getByLabelText('Expand Artifacts')).toBeTruthy());

    // Close the rail.
    act(() => {
      screen.getByLabelText('Collapse side panel').click();
    });
    await waitFor(() => expect(screen.getByLabelText('Expand side panel')).toBeTruthy());

    // From the narrow rail, click memo's compact label -- it was already
    // expanded before the rail closed, and must come back expanded, not
    // toggled off.
    act(() => {
      screen.getByLabelText('Expand memo').click();
    });

    await waitFor(() => expect(screen.getByLabelText('Collapse side panel')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('Hello Memo')).toBeTruthy());
    expect(screen.getByLabelText('Collapse Memo').getAttribute('aria-expanded')).toBe('true');

    // Artifacts was NOT already expanded before the rail closed -- it stays
    // collapsed (opening the rail does not force every section open).
    expect(screen.getByLabelText('Expand Artifacts')).toBeTruthy();
  });

  it('expanding memo and then artifacts leaves both simultaneously open, and a third section opening does not close the first two (multi-open unaffected)', async () => {
    await renderWithRouter(<SessionSidePanels sessionId="session-1" />);
    await waitFor(() => expect(screen.getByLabelText('Expand side panel')).toBeTruthy());

    // Open the rail first (new default is closed).
    act(() => {
      screen.getByLabelText('Expand side panel').click();
    });
    await waitFor(() => expect(screen.getByText('Hello Memo')).toBeTruthy());

    // All three sections start expanded by default -- confirm all three,
    // then collapse-and-reopen bookmarks to prove opening a third section
    // doesn't disturb the other two.
    expect(screen.getByText('Hello Memo')).toBeTruthy();
    expect(screen.getByText(ARTIFACT_TITLE)).toBeTruthy();
    expect(screen.getByText(BOOKMARK_TITLE)).toBeTruthy();

    act(() => {
      screen.getByLabelText('Collapse Bookmarks').click();
    });
    await waitFor(() => expect(screen.getByLabelText('Expand Bookmarks')).toBeTruthy());

    act(() => {
      screen.getByLabelText('Expand Bookmarks').click();
    });

    await waitFor(() => expect(screen.getByText(BOOKMARK_TITLE)).toBeTruthy());
    // Memo and artifacts are still open throughout.
    expect(screen.getByText('Hello Memo')).toBeTruthy();
    expect(screen.getByText(ARTIFACT_TITLE)).toBeTruthy();

    expect(localStorage.getItem(STORAGE_KEY)).toBe(
      JSON.stringify({ railOpen: true, expanded: { memo: true, artifacts: true, bookmarks: true } })
    );
  });

  it('renders exactly one bordered rail element when the rail is open (all sections expanded, R1c DOM pin)', async () => {
    const { container } = await renderWithRouter(<SessionSidePanels sessionId="session-1" />);
    await waitFor(() => expect(screen.getByLabelText('Expand side panel')).toBeTruthy());

    // Open the rail first (new default is closed).
    act(() => {
      screen.getByLabelText('Expand side panel').click();
    });
    await waitFor(() => expect(screen.getByText('Hello Memo')).toBeTruthy());

    const railElements = container.querySelectorAll('[class*="border-l"]');
    expect(railElements.length).toBe(1);
  });

  it('renders exactly one bordered rail element when the rail is closed (R1b/R1d DOM pin, matches the new default)', async () => {
    const { container } = await renderWithRouter(<SessionSidePanels sessionId="session-1" />);
    await waitFor(() => expect(screen.getByLabelText('Expand side panel')).toBeTruthy());

    const railElements = container.querySelectorAll('[class*="border-l"]');
    expect(railElements.length).toBe(1);
  });
});
