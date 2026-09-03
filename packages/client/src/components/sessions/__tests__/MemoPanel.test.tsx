import { describe, it, expect, mock, beforeEach, afterEach, afterAll, spyOn } from 'bun:test';
import { useState } from 'react';
import { screen, cleanup, waitFor, act, fireEvent } from '@testing-library/react';
import { renderWithRouter } from '../../../test/renderWithRouter';
import { MemoPanel } from '../MemoPanel';
import { _reset as resetWebSocket } from '../../../lib/app-websocket';
import { MockWebSocket, installMockWebSocket } from '../../../test/mock-websocket';

// Fetch-level mock (testing.md Anti-Pattern #2: mock at the fetch boundary).
const originalFetch = globalThis.fetch;
const mockFetch = mock(() => Promise.resolve(new Response()));
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

function resolveUrl(url: unknown): string {
  if (typeof url === 'string') return url;
  if (url instanceof URL) return url.href;
  if (url && typeof url === 'object' && 'url' in url) return (url as Request).url;
  return '';
}

/**
 * Find the PUT call made to the memo endpoint and parse its JSON body.
 * Mirrors RestartSessionDialog.test.tsx's findRestartCallBody convention.
 */
function findMemoPutCallBody(): Record<string, unknown> | undefined {
  const calls = mockFetch.mock.calls as unknown[][];
  for (const call of calls) {
    const init = call[1] as (RequestInit & { body?: string }) | undefined;
    if (init?.method === 'PUT' && resolveUrl(call[0]).includes('/memo') && typeof init.body === 'string') {
      return JSON.parse(init.body) as Record<string, unknown>;
    }
  }
  return undefined;
}

function wasMemoPutCalled(): boolean {
  const calls = mockFetch.mock.calls as unknown[][];
  return calls.some((call) => {
    const init = call[1] as RequestInit | undefined;
    return init?.method === 'PUT' && resolveUrl(call[0]).includes('/memo');
  });
}

// The panel is now controlled: isExpanded is a required prop, not internal
// state. This wrapper supplies the isExpanded/onToggleExpanded pair the way
// the real SessionSidePanels container does. compact=false by default: most
// of this file tests a single panel in isolation, standing in for "already
// inside a wide accordion column" -- the compact/rail-chrome rendering is
// covered by SessionSidePanels.test.tsx. One test below (M7) exercises
// compact=true directly, because R1's "always mounted once resolved" change
// made the compact rail reachable with a null memo for the first time (it
// used to be unreachable, since the whole component returned null first).
function ControlledMemoPanel({
  sessionId,
  initialExpanded = true,
  compact = false,
}: {
  sessionId: string;
  initialExpanded?: boolean;
  compact?: boolean;
}) {
  const [isExpanded, setIsExpanded] = useState(initialExpanded);
  return (
    <MemoPanel
      sessionId={sessionId}
      isExpanded={isExpanded}
      onToggleExpanded={() => setIsExpanded((v) => !v)}
      compact={compact}
    />
  );
}

describe('MemoPanel', () => {
  let restoreWebSocket: () => void;
  let originalLocation: Location;
  let consoleLogSpy: ReturnType<typeof spyOn>;
  let consoleErrorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    mockFetch.mockReset();
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

  it('renders nothing while the memo content is pending', async () => {
    // Never resolves during this test -- still pending.
    mockFetch.mockReturnValue(new Promise(() => {}));

    const { container } = await renderWithRouter(<ControlledMemoPanel sessionId="session-1" />);

    expect(container.querySelector('[aria-label="Collapse memo"]')).toBeNull();
    expect(container.textContent).toBe('');
  });

  // M1: inverted from "renders nothing when the memo content is null" (R1 --
  // the panel now stays mounted once resolved, even to null).
  it('renders the empty state with a Write memo button when the memo content is null', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ content: null }));

    await renderWithRouter(<ControlledMemoPanel sessionId="session-1" />);

    await waitFor(() => expect(screen.getByText('No memo yet.')).toBeTruthy());
    expect(screen.getByRole('button', { name: /write memo/i })).toBeTruthy();
  });

  it('renders the markdown content when expanded', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ content: '# Hello Memo' }));

    await renderWithRouter(<ControlledMemoPanel sessionId="session-1" />);

    await waitFor(() => expect(screen.getByText('Hello Memo')).toBeTruthy());
    expect(screen.getByText('Hello Memo').tagName).toBe('H1');
  });

  it('collapses to a thin strip and can be re-expanded', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ content: '# Hello Memo' }));

    await renderWithRouter(<ControlledMemoPanel sessionId="session-1" />);
    await waitFor(() => expect(screen.getByText('Hello Memo')).toBeTruthy());

    screen.getByLabelText('Collapse memo').click();

    await waitFor(() => expect(screen.getByLabelText('Expand memo')).toBeTruthy());
    expect(screen.queryByText('Hello Memo')).toBeNull();

    screen.getByLabelText('Expand memo').click();
    await waitFor(() => expect(screen.getByText('Hello Memo')).toBeTruthy());
  });

  it('updates the rendered content when a memo-updated WebSocket event arrives for this session', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ content: '# Original' }));

    await renderWithRouter(<ControlledMemoPanel sessionId="session-1" />);
    await waitFor(() => expect(screen.getByText('Original')).toBeTruthy());

    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
      ws?.simulateMessage(
        JSON.stringify({ type: 'memo-updated', sessionId: 'session-1', content: '# Updated' })
      );
    });

    await waitFor(() => expect(screen.getByText('Updated')).toBeTruthy());
    expect(screen.queryByText('Original')).toBeNull();
  });

  it('ignores a memo-updated WebSocket event for a different session', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ content: '# Original' }));

    await renderWithRouter(<ControlledMemoPanel sessionId="session-1" />);
    await waitFor(() => expect(screen.getByText('Original')).toBeTruthy());

    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
      ws?.simulateMessage(
        JSON.stringify({ type: 'memo-updated', sessionId: 'session-other', content: '# Should Not Apply' })
      );
    });

    // No way to await a negative directly -- flush a tick, then assert the
    // original content is still the one on screen (workflow.md: absence
    // assertions must be taken after the boundary the event would have
    // written past, which a settled fetch + a delivered (but non-matching)
    // WS message both satisfy here).
    await waitFor(() => expect(screen.getByText('Original')).toBeTruthy());
    expect(screen.queryByText('Should Not Apply')).toBeNull();
  });

  // M2: empty state -> Write memo -> type -> Save -> PUT fires with the
  // typed text -> the server's response content is what ends up rendered.
  it('writing a first memo from the empty state saves via PUT and renders the server response', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ content: null }));

    await renderWithRouter(<ControlledMemoPanel sessionId="session-1" />);
    await waitFor(() => expect(screen.getByText('No memo yet.')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /write memo/i }));

    const textarea = await screen.findByLabelText('Memo content');
    fireEvent.change(textarea, { target: { value: 'Updated memo body' } });

    mockFetch.mockResolvedValueOnce(jsonResponse({ content: 'Updated memo body' }));
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      const body = findMemoPutCallBody();
      expect(body).toEqual({ content: 'Updated memo body' });
    });

    // The rendered Markdown view replaces the textarea after a successful save.
    await waitFor(() => expect(screen.getByText('Updated memo body')).toBeTruthy());
    expect(screen.queryByLabelText('Memo content')).toBeNull();
  });

  // M3: existing memo -> Edit -> textarea pre-filled -> Cancel -> unchanged
  // view restored, no PUT fired.
  it('editing an existing memo then cancelling restores the original view without saving', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ content: '# Existing memo' }));

    await renderWithRouter(<ControlledMemoPanel sessionId="session-1" />);
    await waitFor(() => expect(screen.getByText('Existing memo')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Edit memo' }));

    const textarea = await screen.findByLabelText('Memo content');
    expect((textarea as HTMLTextAreaElement).value).toBe('# Existing memo');

    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    await waitFor(() => expect(screen.getByText('Existing memo')).toBeTruthy());
    expect(screen.getByText('Existing memo').tagName).toBe('H1');
    expect(screen.queryByLabelText('Memo content')).toBeNull();
    expect(wasMemoPutCalled()).toBe(false);
  });

  // M4: Ctrl+Enter saves, Escape behavior depends on whether the draft changed.
  describe('keyboard shortcuts in the textarea', () => {
    it('Ctrl+Enter triggers the same save as clicking the Save button', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ content: '# Existing memo' }));

      await renderWithRouter(<ControlledMemoPanel sessionId="session-1" />);
      await waitFor(() => expect(screen.getByText('Existing memo')).toBeTruthy());

      fireEvent.click(screen.getByRole('button', { name: 'Edit memo' }));
      const textarea = await screen.findByLabelText('Memo content');
      fireEvent.change(textarea, { target: { value: 'Saved via ctrl+enter' } });

      mockFetch.mockResolvedValueOnce(jsonResponse({ content: 'Saved via ctrl+enter' }));
      fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });

      await waitFor(() => {
        const body = findMemoPutCallBody();
        expect(body).toEqual({ content: 'Saved via ctrl+enter' });
      });
      await waitFor(() => expect(screen.getByText('Saved via ctrl+enter')).toBeTruthy());
    });

    it('Escape does nothing when the draft has changed -- it must not discard the edit', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ content: '# Existing memo' }));

      await renderWithRouter(<ControlledMemoPanel sessionId="session-1" />);
      await waitFor(() => expect(screen.getByText('Existing memo')).toBeTruthy());

      fireEvent.click(screen.getByRole('button', { name: 'Edit memo' }));
      const textarea = await screen.findByLabelText('Memo content');
      fireEvent.change(textarea, { target: { value: 'An unsaved change' } });

      fireEvent.keyDown(textarea, { key: 'Escape' });

      // Still in edit mode with the changed text intact.
      expect((screen.getByLabelText('Memo content') as HTMLTextAreaElement).value).toBe('An unsaved change');
      expect(wasMemoPutCalled()).toBe(false);
    });

    it('Escape cancels back to view mode when the draft is unchanged from what it was seeded with', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ content: '# Existing memo' }));

      await renderWithRouter(<ControlledMemoPanel sessionId="session-1" />);
      await waitFor(() => expect(screen.getByText('Existing memo')).toBeTruthy());

      fireEvent.click(screen.getByRole('button', { name: 'Edit memo' }));
      const textarea = await screen.findByLabelText('Memo content');

      fireEvent.keyDown(textarea, { key: 'Escape' });

      await waitFor(() => expect(screen.queryByLabelText('Memo content')).toBeNull());
      expect(screen.getByText('Existing memo').tagName).toBe('H1');
    });
  });

  // M5: R6 -- an incoming memo-updated event while editing updates the cache
  // but never clobbers the in-progress draft; "Load latest" pulls it in.
  describe('agent write while a human is editing (R6)', () => {
    it('shows a notice and preserves the draft, then loads the latest content on demand', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ content: '# Existing memo' }));

      await renderWithRouter(<ControlledMemoPanel sessionId="session-1" />);
      await waitFor(() => expect(screen.getByText('Existing memo')).toBeTruthy());

      fireEvent.click(screen.getByRole('button', { name: 'Edit memo' }));
      const textarea = await screen.findByLabelText('Memo content');
      fireEvent.change(textarea, { target: { value: 'My unsaved draft' } });

      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
        ws?.simulateMessage(
          JSON.stringify({ type: 'memo-updated', sessionId: 'session-1', content: 'Agent wrote this' })
        );
      });

      await waitFor(() => expect(screen.getByText(/updated while you were editing/i)).toBeTruthy());
      // The draft is untouched by the incoming event.
      expect((screen.getByLabelText('Memo content') as HTMLTextAreaElement).value).toBe('My unsaved draft');

      fireEvent.click(screen.getByRole('button', { name: /load latest/i }));

      expect((screen.getByLabelText('Memo content') as HTMLTextAreaElement).value).toBe('Agent wrote this');
      expect(screen.queryByText(/updated while you were editing/i)).toBeNull();
    });

    it('while editing, ignores a memo-updated WebSocket event for a different session (no notice, no draft change)', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ content: '# Existing memo' }));

      await renderWithRouter(<ControlledMemoPanel sessionId="session-1" />);
      await waitFor(() => expect(screen.getByText('Existing memo')).toBeTruthy());

      fireEvent.click(screen.getByRole('button', { name: 'Edit memo' }));
      const textarea = await screen.findByLabelText('Memo content');
      fireEvent.change(textarea, { target: { value: 'My unsaved draft' } });

      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
        ws?.simulateMessage(
          JSON.stringify({ type: 'memo-updated', sessionId: 'session-other', content: 'Should not apply' })
        );
      });

      // Flush a tick (no positive event to await), then assert nothing moved.
      await waitFor(() => expect(screen.getByLabelText('Memo content')).toBeTruthy());
      expect(screen.queryByText(/updated while you were editing/i)).toBeNull();
      expect((screen.getByLabelText('Memo content') as HTMLTextAreaElement).value).toBe('My unsaved draft');
    });
  });

  // CodeRabbit MAJOR finding: a memo-updated WS event that lands while a
  // save's PUT is in flight carries the newer content into the cache; the
  // save's own (now-stale) response must not overwrite it once it resolves.
  it('a memo-updated event that arrives during an in-flight save wins over the save response', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ content: '# Existing memo' }));

    await renderWithRouter(<ControlledMemoPanel sessionId="session-1" />);
    await waitFor(() => expect(screen.getByText('Existing memo')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Edit memo' }));
    const textarea = await screen.findByLabelText('Memo content');
    fireEvent.change(textarea, { target: { value: 'Draft before race' } });

    // Hold the PUT open so a WS event can race in ahead of its response.
    let resolvePut: (value: Response) => void;
    mockFetch.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolvePut = resolve;
        })
    );

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      const body = findMemoPutCallBody();
      expect(body).toEqual({ content: 'Draft before race' });
    });

    // A memo-updated WS event for the same session lands while the PUT is
    // still pending -- its newer content must win.
    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
      ws?.simulateMessage(
        JSON.stringify({ type: 'memo-updated', sessionId: 'session-1', content: '# Raced in first' })
      );
    });

    // The in-flight save now resolves, carrying the ORIGINAL (pre-race)
    // content as its response -- this must not regress the cache past what
    // the WS event just delivered.
    await act(async () => {
      resolvePut(jsonResponse({ content: 'Draft before race' }));
    });

    await waitFor(() => expect(screen.getByText('Raced in first')).toBeTruthy());
    expect(screen.queryByText('Draft before race')).toBeNull();
  });

  // CodeRabbit MAJOR finding: the textarea (not just the Save/Cancel
  // buttons) must be disabled while a save is in flight, otherwise a user
  // can keep typing (or Ctrl+Enter again) during the save window.
  it('disables the textarea while a save is in flight', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ content: '# Existing memo' }));

    await renderWithRouter(<ControlledMemoPanel sessionId="session-1" />);
    await waitFor(() => expect(screen.getByText('Existing memo')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Edit memo' }));
    const textarea = await screen.findByLabelText('Memo content');
    fireEvent.change(textarea, { target: { value: 'Change during save' } });

    let resolvePut: (value: Response) => void;
    mockFetch.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolvePut = resolve;
        })
    );

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(findMemoPutCallBody()).toEqual({ content: 'Change during save' }));
    expect((screen.getByLabelText('Memo content') as HTMLTextAreaElement).disabled).toBe(true);

    await act(async () => {
      resolvePut(jsonResponse({ content: 'Change during save' }));
    });

    await waitFor(() => expect(screen.queryByLabelText('Memo content')).toBeNull());
  });

  // M6: R4 client half -- a broadcast deletion (content: '') renders the
  // same empty state as a null memo, not a blank Markdown body.
  it('renders the empty state when a memo-updated event carries an empty string (broadcast deletion)', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ content: '# Existing memo' }));

    await renderWithRouter(<ControlledMemoPanel sessionId="session-1" />);
    await waitFor(() => expect(screen.getByText('Existing memo')).toBeTruthy());

    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
      ws?.simulateMessage(JSON.stringify({ type: 'memo-updated', sessionId: 'session-1', content: '' }));
    });

    await waitFor(() => expect(screen.getByText('No memo yet.')).toBeTruthy());
    expect(screen.getByRole('button', { name: /write memo/i })).toBeTruthy();
    expect(screen.queryByText('Existing memo')).toBeNull();
  });

  // M7: with compact=true, the rail label must render once the query
  // resolves even when the memo is null -- this used to be unreachable
  // because the whole component returned null before content was checked.
  it('renders the compact rail label even when the resolved memo content is null', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ content: null }));

    await renderWithRouter(<ControlledMemoPanel sessionId="session-1" compact />);

    await waitFor(() => expect(screen.getByLabelText('Expand memo')).toBeTruthy());
    expect(screen.getByText('Memo')).toBeTruthy();
  });
});
