import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import { useState } from 'react';
import { screen, cleanup, waitFor } from '@testing-library/react';
import { renderWithRouter } from '../../../test/renderWithRouter';
import { SessionArtifactsPanel } from '../SessionArtifactsPanel';

// The panel is now controlled: isExpanded is a required prop, not internal
// state. This wrapper supplies the isExpanded/onToggleExpanded pair the way
// the real SessionSidePanels container does, so the existing collapse/expand
// assertions below keep exercising real toggle behavior.
function ControlledArtifactsPanel({
  sessionId,
  initialExpanded = true,
}: {
  sessionId: string;
  initialExpanded?: boolean;
}) {
  const [isExpanded, setIsExpanded] = useState(initialExpanded);
  return (
    <SessionArtifactsPanel
      sessionId={sessionId}
      isExpanded={isExpanded}
      onToggleExpanded={() => setIsExpanded((v) => !v)}
      compact={false}
    />
  );
}

// Fetch-level mock (testing.md Anti-Pattern #2: mock at the fetch boundary).
const originalFetch = globalThis.fetch;
const mockFetch = mock(() => Promise.resolve(new Response()));
globalThis.fetch = Object.assign(mockFetch, { preconnect: () => {} }) as typeof fetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  cleanup();
});

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('SessionArtifactsPanel', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('renders nothing while the artifact list is pending', async () => {
    // Never resolves during this test -- still pending.
    mockFetch.mockReturnValue(new Promise(() => {}));

    const { container } = await renderWithRouter(<ControlledArtifactsPanel sessionId="session-1" />);

    expect(container.querySelector('[aria-label="Collapse artifacts"]')).toBeNull();
    expect(container.textContent).toBe('');
  });

  it('renders nothing when the session has no artifacts (same as Memo with no content)', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ artifacts: [] }));

    const { container } = await renderWithRouter(<ControlledArtifactsPanel sessionId="session-1" />);

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    // Give the pending -> resolved transition a tick to settle.
    await waitFor(() => expect(container.textContent).toBe(''));
  });

  it('renders the artifact list with a plain full-document anchor deep link (#1340 jail rule)', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        artifacts: [
          { id: 'artifact-1', title: 'My Dashboard', createdAt: '2026-08-16T00:00:00.000Z', sizeBytes: 1234 },
        ],
      })
    );

    await renderWithRouter(<ControlledArtifactsPanel sessionId="session-1" />);

    await waitFor(() => expect(screen.getByText('My Dashboard')).toBeTruthy());

    const link = screen.getByText('View').closest('a')!;
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe('/artifacts/artifact-1');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('collapses to a thin strip and can be re-expanded', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        artifacts: [
          { id: 'artifact-1', title: 'My Dashboard', createdAt: '2026-08-16T00:00:00.000Z', sizeBytes: 1234 },
        ],
      })
    );

    await renderWithRouter(<ControlledArtifactsPanel sessionId="session-1" />);
    await waitFor(() => expect(screen.getByText('My Dashboard')).toBeTruthy());

    screen.getByLabelText('Collapse artifacts').click();

    await waitFor(() => expect(screen.getByLabelText('Expand artifacts')).toBeTruthy());
    expect(screen.queryByText('My Dashboard')).toBeNull();

    screen.getByLabelText('Expand artifacts').click();
    await waitFor(() => expect(screen.getByText('My Dashboard')).toBeTruthy());
  });
});
