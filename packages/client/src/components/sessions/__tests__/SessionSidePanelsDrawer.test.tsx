import { useState } from 'react';
import { describe, it, expect, mock, beforeEach, afterEach, afterAll, spyOn } from 'bun:test';
import { screen, cleanup, waitFor, act, fireEvent, renderHook } from '@testing-library/react';
import { renderWithRouter } from '../../../test/renderWithRouter';
import { SessionSidePanelsDrawer } from '../SessionSidePanelsDrawer';
import { useSessionSidePanelsState } from '../hooks/useSessionSidePanelsState';
import { _reset as resetWebSocket } from '../../../lib/app-websocket';
import { installMockWebSocket } from '../../../test/mock-websocket';

/**
 * `renderWithRouter`'s `rerender` cannot be used to change `open` mid-test:
 * RTL's `rerender(ui)` replaces the ENTIRE previously-rendered tree with the
 * new element, discarding `renderWithRouter`'s own
 * `QueryClientProvider`/`RouterProvider` wrapper (it was never registered as
 * an RTL `wrapper` option -- `renderWithRouter` calls `render()` directly).
 * This harness keeps `open` as internal state so the transition happens
 * inside a single render, without ever needing to swap the tree's root.
 */
function OpenToggleHarness({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen((prev) => !prev)}>
        toggle-open
      </button>
      <SessionSidePanelsDrawer sessionId={sessionId} open={open} onClose={() => setOpen(false)} />
    </>
  );
}

// Fetch-level mock (testing.md Anti-Pattern #2: mock at the fetch boundary).
// Routed by URL substring -- same pattern as SessionSidePanels.test.tsx,
// which this file's setup deliberately mirrors so the two containers are
// tested under identical conditions.
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

function routeFetchEmpty(): void {
  mockFetch.mockImplementation((input: RequestInfo | URL) => {
    const url = urlToString(input);
    if (url.includes('/memo')) {
      return Promise.resolve(jsonResponse({ content: '' }));
    }
    if (url.includes('/artifacts')) {
      return Promise.resolve(jsonResponse({ artifacts: [] }));
    }
    if (url.includes('/bookmarks')) {
      return Promise.resolve(jsonResponse({ bookmarks: [] }));
    }
    return Promise.resolve(jsonResponse({}, 404));
  });
}

const STORAGE_KEY = 'agent-console:session-side-panels-v2';

describe('SessionSidePanelsDrawer', () => {
  let restoreWebSocket: () => void;
  let originalLocation: Location;
  let consoleLogSpy: ReturnType<typeof spyOn>;
  let consoleErrorSpy: ReturnType<typeof spyOn>;
  let originalOverflow: string;

  beforeEach(() => {
    localStorage.clear();
    mockFetch.mockReset();
    routeFetchByPanel();

    originalLocation = window.location;
    restoreWebSocket = installMockWebSocket();
    Object.defineProperty(window, 'location', {
      value: { protocol: 'http:', host: 'localhost:3000' },
      writable: true,
    });
    consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
    resetWebSocket();

    originalOverflow = document.body.style.overflow;
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
    document.body.style.overflow = originalOverflow;
  });

  describe('Rendering', () => {
    it('has dialog role with correct ARIA attributes when open', async () => {
      // Reach (measured): changing aria-label to "Sessions drawer" (the
      // precedent's label) fails here. Hardcoding aria-modal="true" does NOT
      // fail here -- that mutation is caught by the closed-state test below.
      await renderWithRouter(<SessionSidePanelsDrawer sessionId="session-1" open={true} onClose={() => {}} />);
      const dialog = await waitFor(() => screen.getByRole('dialog'));
      expect(dialog).toBeTruthy();
      expect(dialog.getAttribute('aria-modal')).toBe('true');
      expect(dialog.getAttribute('aria-label')).toBe('Session panels');
    });

    it('does not have aria-modal when closed, but the dialog element stays in the DOM', async () => {
      // Reach (measured): hardcoding aria-modal="true" fails; hardcoding
      // aria-hidden={false} fails. Each caught only here.
      await renderWithRouter(<SessionSidePanelsDrawer sessionId="session-1" open={false} onClose={() => {}} />);
      const dialog = document.querySelector('[role="dialog"]');
      expect(dialog).toBeTruthy();
      expect(dialog!.getAttribute('aria-modal')).toBeNull();
      expect(dialog!.getAttribute('aria-hidden')).toBe('true');
    });

    it('applies translate-x-0 and right-anchoring classes when open', async () => {
      // Reach (measured): swapping the translate pair (open -> translate-x-full)
      // fails here and in the closed-state test below; `right-0` -> `left-0`
      // (the precedent's anchoring) fails only here.
      await renderWithRouter(<SessionSidePanelsDrawer sessionId="session-1" open={true} onClose={() => {}} />);
      const dialog = await waitFor(() => screen.getByRole('dialog'));
      const classList = dialog.className.split(' ');
      expect(classList).toContain('translate-x-0');
      expect(classList).not.toContain('translate-x-full');
      expect(classList).toContain('right-0');
      expect(classList).toContain('w-80');
      expect(classList).toContain('max-w-[100vw]');
      expect(classList).toContain('overflow-y-auto');
      expect(classList).not.toContain('left-0');
    });

    it('applies translate-x-full class when closed', async () => {
      // Reach (measured): swapping the translate pair fails here.
      await renderWithRouter(<SessionSidePanelsDrawer sessionId="session-1" open={false} onClose={() => {}} />);
      const dialog = document.querySelector('[role="dialog"]');
      expect(dialog).toBeTruthy();
      expect(dialog!.className).toContain('translate-x-full');
      expect(dialog!.className).not.toContain('translate-x-0');
    });

    it('renders the three section headers in Memo, Artifacts, Bookmarks order and no rail toggle', async () => {
      // Reach (measured): swapping the Artifacts and Bookmarks elements in
      // SessionSidePanelsDrawer.tsx fails the second compareDocumentPosition
      // assertion; rendering an extra `aria-label="Collapse side panel"`
      // button inside the drawer (a rail toggle) fails the last assertions.
      await renderWithRouter(<SessionSidePanelsDrawer sessionId="session-1" open={true} onClose={() => {}} />);
      const memoHeader = await waitFor(() => screen.getByLabelText('Collapse Memo'));
      const artifactsHeader = screen.getByLabelText('Collapse Artifacts');
      const bookmarksHeader = screen.getByLabelText('Collapse Bookmarks');

      // Node.compareDocumentPosition returns a bitmask; DOCUMENT_POSITION_FOLLOWING (4)
      // means the argument follows the node it's called on.
      expect(
        memoHeader.compareDocumentPosition(artifactsHeader) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
      expect(
        artifactsHeader.compareDocumentPosition(bookmarksHeader) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();

      expect(screen.queryByLabelText('Collapse side panel')).toBeNull();
      expect(screen.queryByLabelText('Expand side panel')).toBeNull();
    });

    it('shows Memo and Bookmarks headers when empty, but Artifacts renders nothing for an empty list (matches SessionArtifactsPanel\'s own "render nothing when empty" contract)', async () => {
      // Deviation from the AC as written: the AC expected all three headers
      // to render for an all-empty state. Measured against the actual,
      // unmodified SessionArtifactsPanel.tsx (shared with the desktop rail,
      // not something this PR touches): it explicitly returns null when
      // `artifacts.length === 0` ("Don't render anything while loading, or
      // when the session has no artifacts" -- SessionArtifactsPanel.tsx
      // L26-28), unlike MemoPanel (renders a "No memo yet." + Write-memo
      // fallback inside a still-visible header) and SessionBookmarksPanel
      // (renders an empty list + an add-bookmark form under a still-visible
      // header). This assertion pins the real, current contract rather than
      // the AC's assumption.
      routeFetchEmpty();
      await renderWithRouter(<SessionSidePanelsDrawer sessionId="session-1" open={true} onClose={() => {}} />);
      await waitFor(() => expect(screen.getByLabelText('Collapse Memo')).toBeTruthy());
      await waitFor(() => expect(screen.getByLabelText('Collapse Bookmarks')).toBeTruthy());
      expect(screen.queryByLabelText('Collapse Artifacts')).toBeNull();
      expect(screen.queryByLabelText('Expand Artifacts')).toBeNull();
    });

    it('renders the memo Edit button since compact is always false', async () => {
      // Reach (measured): passing `compact={true}` to MemoPanel in the drawer
      // fails here (MemoPanel's compact branch never renders Edit), and also
      // fails the two header tests above (the compact branch has no
      // 'Collapse Memo' header either).
      await renderWithRouter(<SessionSidePanelsDrawer sessionId="session-1" open={true} onClose={() => {}} />);
      await waitFor(() => expect(screen.getByText('Hello Memo')).toBeTruthy());
      expect(screen.getByLabelText('Edit memo')).toBeTruthy();
    });
  });

  describe('Interactions', () => {
    it('calls onClose when backdrop is clicked', async () => {
      // Reach (measured): removing the backdrop's onClick fails here.
      const onClose = mock(() => {});
      await renderWithRouter(<SessionSidePanelsDrawer sessionId="session-1" open={true} onClose={onClose} />);
      await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
      const backdrop = document.querySelector('[aria-hidden="true"]');
      expect(backdrop).toBeTruthy();
      fireEvent.click(backdrop!);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('calls onClose on Escape keydown when open', async () => {
      // Reach (measured): changing the handled key from 'Escape' to 'Enter'
      // fails here.
      const onClose = mock(() => {});
      await renderWithRouter(<SessionSidePanelsDrawer sessionId="session-1" open={true} onClose={onClose} />);
      await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('does nothing on Escape when closed', async () => {
      // Reach (measured): dropping the effect's `if (!open) return` guard
      // (listener registered while closed) fails here.
      const onClose = mock(() => {});
      await renderWithRouter(<SessionSidePanelsDrawer sessionId="session-1" open={false} onClose={onClose} />);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe('Body scroll prevention', () => {
    it('sets body overflow to hidden when open', async () => {
      // Reach (measured): removing the `overflow = 'hidden'` write fails here
      // and in the restore test below.
      await renderWithRouter(<SessionSidePanelsDrawer sessionId="session-1" open={true} onClose={() => {}} />);
      await waitFor(() => expect(document.body.style.overflow).toBe('hidden'));
    });

    it('restores body overflow after the open prop transitions to false', async () => {
      // Reach (measured): removing the effect's cleanup (`overflow = original`)
      // fails here (body stays 'hidden' after the toggle). Dropping the
      // `if (!open) return` guard also fails here: the cleanup then restores
      // the value the closed render itself had just overwritten.
      await renderWithRouter(<OpenToggleHarness sessionId="session-1" />);
      await waitFor(() => expect(document.body.style.overflow).toBe('hidden'));

      act(() => {
        screen.getByText('toggle-open').click();
      });
      expect(document.body.style.overflow).not.toBe('hidden');
    });

    it('does not touch body overflow when rendered closed', async () => {
      // Reach (measured): dropping the scroll-lock effect's `if (!open) return`
      // guard fails here.
      const before = document.body.style.overflow;
      await renderWithRouter(<SessionSidePanelsDrawer sessionId="session-1" open={false} onClose={() => {}} />);
      expect(document.body.style.overflow).toBe(before);
    });
  });

  describe('Persistence (shared record with the desktop rail)', () => {
    it('collapsing Artifacts here persists to the SAME storage key/shape a fresh hook instance reads back', async () => {
      // Reach (measured), four mutations, each fails only here:
      // (a) the hook's STORAGE_KEY changed to '...-v3' (the drawer persists
      //     under a key other than the one the rail has always used) -- the
      //     literal STORAGE_KEY read below returns null;
      // (b) the drawer holding its own `useState` record instead of calling
      //     `useSessionSidePanelsState()` -- nothing is persisted at all;
      // (c) the Artifacts panel's `onToggleExpanded` writing 'bookmarks'
      //     (wrong section) -- 'Expand Artifacts' never appears;
      // (d) the drawer calling `toggleRail()` on every section toggle -- the
      //     `railOpen === false` assertions fail.
      await renderWithRouter(<SessionSidePanelsDrawer sessionId="session-1" open={true} onClose={() => {}} />);
      await waitFor(() => expect(screen.getByLabelText('Collapse Artifacts')).toBeTruthy());

      act(() => {
        screen.getByLabelText('Collapse Artifacts').click();
      });

      await waitFor(() => expect(screen.getByLabelText('Expand Artifacts')).toBeTruthy());

      const stored = localStorage.getItem(STORAGE_KEY);
      expect(stored).toBeTruthy();
      const parsed = JSON.parse(stored!) as { railOpen: boolean; expanded: Record<string, boolean> };
      expect(parsed.expanded.artifacts).toBe(false);
      // The drawer never writes railOpen -- it stays at its default (false).
      expect(parsed.railOpen).toBe(false);

      const { result } = renderHook(() => useSessionSidePanelsState());
      expect(result.current.expanded.artifacts).toBe(false);
      expect(result.current.railOpen).toBe(false);
    });
  });
});
