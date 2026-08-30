import { describe, it, expect, mock, beforeEach, afterEach, afterAll, spyOn } from 'bun:test';
import { useState } from 'react';
import { screen, cleanup, waitFor, act } from '@testing-library/react';
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

// The panel is now controlled: isExpanded is a required prop, not internal
// state. This wrapper supplies the isExpanded/onToggleExpanded pair the way
// the real SessionSidePanels container does.
function ControlledMemoPanel({
  sessionId,
  initialExpanded = true,
}: {
  sessionId: string;
  initialExpanded?: boolean;
}) {
  const [isExpanded, setIsExpanded] = useState(initialExpanded);
  return (
    <MemoPanel
      sessionId={sessionId}
      isExpanded={isExpanded}
      onToggleExpanded={() => setIsExpanded((v) => !v)}
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

  it('renders nothing when the memo content is null', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ content: null }));

    const { container } = await renderWithRouter(<ControlledMemoPanel sessionId="session-1" />);

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    await waitFor(() => expect(container.textContent).toBe(''));
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
});
