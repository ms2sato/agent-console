import { describe, it, expect, mock, afterEach, beforeEach } from 'bun:test';
import { screen, cleanup, waitFor, within, act } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { renderWithRouter } from '../../../test/renderWithRouter';
import { ArtifactsPage } from '../index';
import { _reset as resetWebSocket } from '../../../lib/app-websocket';
import { MockWebSocket, installMockWebSocket } from '../../../test/mock-websocket';

// --- Fetch-level mocking ---

const originalFetch = globalThis.fetch;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let listResponse: unknown = { artifacts: [] };
let listStatus = 200;
let deleteCalledWithId: string | null = null;
let deleteStatus = 200;

const mockFetch = mock(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = input instanceof Request ? input.url : String(input);
  const method = (input instanceof Request ? input.method : init?.method) ?? 'GET';

  if (url.includes('/api/artifacts/') && method === 'DELETE') {
    const id = url.split('/api/artifacts/')[1];
    deleteCalledWithId = id ?? null;
    if (deleteStatus !== 200) {
      return jsonResponse({ error: 'Only the owner can delete this artifact' }, deleteStatus);
    }
    return jsonResponse({ success: true });
  }

  if (url.includes('/api/artifacts')) {
    return jsonResponse(listResponse, listStatus);
  }

  return jsonResponse({});
});

let restoreWebSocket: () => void;

beforeEach(() => {
  globalThis.fetch = Object.assign(mockFetch, { preconnect: () => {} }) as typeof fetch;
  listResponse = { artifacts: [] };
  listStatus = 200;
  deleteCalledWithId = null;
  deleteStatus = 200;
  restoreWebSocket = installMockWebSocket();
  resetWebSocket();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  mockFetch.mockClear();
  restoreWebSocket();
});

describe('ArtifactsPage', () => {
  it('renders the empty state when there are no artifacts', async () => {
    listResponse = { artifacts: [] };
    await renderWithRouter(<ArtifactsPage />);

    await waitFor(() => {
      expect(screen.getByText('No artifacts found')).toBeTruthy();
    });
  });

  it('renders the error state when the fetch fails', async () => {
    listStatus = 500;
    listResponse = {};
    await renderWithRouter(<ArtifactsPage />);

    await waitFor(() => {
      expect(screen.getByText('Failed to load artifacts')).toBeTruthy();
    });
  });

  it('shows "Updated <time>" under the created time only for an updated artifact', async () => {
    listResponse = {
      artifacts: [
        { id: 'artifact-u', title: 'Updated Doc', createdAt: '2026-08-16T00:00:00.000Z', sizeBytes: 10, updatedAt: '2026-08-17T00:00:00.000Z' },
        { id: 'artifact-n', title: 'Plain Doc', createdAt: '2026-08-16T00:00:00.000Z', sizeBytes: 10, updatedAt: null },
      ],
    };
    await renderWithRouter(<ArtifactsPage />);

    await waitFor(() => {
      expect(screen.getByText('Updated Doc')).toBeTruthy();
    });
    const rows = screen.getAllByRole('row');
    const updatedRow = rows.find((r) => r.textContent?.includes('Updated Doc'))!;
    const plainRow = rows.find((r) => r.textContent?.includes('Plain Doc'))!;
    expect(updatedRow.textContent).toContain('Updated ');
    expect(plainRow.textContent).not.toContain('Updated');
  });

  it('renders artifact rows with title, formatted size, and a plain view anchor (not a router Link)', async () => {
    listResponse = {
      artifacts: [
        { id: 'artifact-1', title: 'My Dashboard', createdAt: '2026-08-16T00:00:00.000Z', sizeBytes: 1234, updatedAt: null },
      ],
    };
    await renderWithRouter(<ArtifactsPage />);

    await waitFor(() => {
      expect(screen.getByText('My Dashboard')).toBeTruthy();
    });
    expect(screen.getByText('1.2 KB')).toBeTruthy();

    const viewLink = screen.getByText('View');
    expect(viewLink.tagName).toBe('A');
    expect(viewLink.getAttribute('href')).toBe('/artifacts/artifact-1');
  });

  it('does NOT re-sort the server-provided artifact order', async () => {
    listResponse = {
      artifacts: [
        { id: 'artifact-b', title: 'B Artifact', createdAt: '2026-08-16T00:00:00.000Z', sizeBytes: 10, updatedAt: null },
        { id: 'artifact-a', title: 'A Artifact', createdAt: '2026-08-15T00:00:00.000Z', sizeBytes: 20, updatedAt: null },
      ],
    };
    await renderWithRouter(<ArtifactsPage />);

    await waitFor(() => {
      expect(screen.getByText('B Artifact')).toBeTruthy();
    });

    const rows = screen.getAllByRole('row').slice(1); // skip header row
    expect(within(rows[0]).getByText('B Artifact')).toBeTruthy();
    expect(within(rows[1]).getByText('A Artifact')).toBeTruthy();
  });

  it('deletes an artifact after confirmation and refetches the list', async () => {
    listResponse = {
      artifacts: [
        { id: 'artifact-1', title: 'My Dashboard', createdAt: '2026-08-16T00:00:00.000Z', sizeBytes: 1234, updatedAt: null },
      ],
    };
    await renderWithRouter(<ArtifactsPage />);

    await waitFor(() => {
      expect(screen.getByText('My Dashboard')).toBeTruthy();
    });

    const user = userEvent.setup();
    await user.click(screen.getByText('Delete'));

    // Confirmation dialog appears
    await waitFor(() => {
      expect(screen.getByText(/Are you sure you want to delete "My Dashboard"/)).toBeTruthy();
    });

    // After confirming, the list is empty
    listResponse = { artifacts: [] };
    // Two elements now read "Delete": the row action button and the
    // dialog's confirm button. The dialog's confirm button is the last one.
    const dialogConfirmButtons = screen.getAllByText('Delete');
    await user.click(dialogConfirmButtons[dialogConfirmButtons.length - 1]);

    await waitFor(() => {
      expect(deleteCalledWithId).toBe('artifact-1');
    });

    await waitFor(() => {
      expect(screen.getByText('No artifacts found')).toBeTruthy();
    });
  });

  it('T1(b): renders an artifact title containing <script> as text, not live markup', async () => {
    const dangerousTitle = 'Evil <script>alert(1)</script>';
    listResponse = {
      artifacts: [
        { id: 'artifact-1', title: dangerousTitle, createdAt: '2026-08-16T00:00:00.000Z', sizeBytes: 10, updatedAt: null },
      ],
    };
    await renderWithRouter(<ArtifactsPage />);

    await waitFor(() => {
      // getByText matching the full, un-mangled string proves the title was
      // rendered as a JSX text child ({artifact.title}), not injected via
      // dangerouslySetInnerHTML (which would parse the <script> tag into a
      // real DOM element and the raw string would no longer be a single
      // text node match).
      expect(screen.getByText(dangerousTitle)).toBeTruthy();
    });

    // No live <script> element entered the DOM from the artifact title.
    expect(document.querySelector('script')).toBeNull();
  });

  // Issue #1520: realtime refresh. Unscoped by sessionId (unlike
  // useSessionArtifacts) -- this route shows the user's whole artifact
  // history, so ANY artifact-created/deleted message refetches it. N1: the
  // message carries only routing metadata, never rendered.
  describe('realtime refresh (artifact-created / artifact-deleted)', () => {
    it('refetches the list when an artifact-created message arrives', async () => {
      listResponse = { artifacts: [] };
      await renderWithRouter(<ArtifactsPage />);

      await waitFor(() => {
        expect(screen.getByText('No artifacts found')).toBeTruthy();
      });

      listResponse = {
        artifacts: [
          { id: 'artifact-new', title: 'Freshly Created', createdAt: '2026-08-20T00:00:00.000Z', sizeBytes: 42, updatedAt: null },
        ],
      };

      const ws = MockWebSocket.getLastInstance();
      await act(async () => {
        ws?.simulateOpen();
        ws?.simulateMessage(
          JSON.stringify({ type: 'artifact-created', sessionId: 'some-session', artifactId: 'artifact-new' })
        );
      });

      await waitFor(() => {
        expect(screen.getByText('Freshly Created')).toBeTruthy();
      });
    });

    it('refetches the list when an artifact-updated message arrives (an in-place update changes the row)', async () => {
      listResponse = {
        artifacts: [
          { id: 'artifact-1', title: 'My Dashboard', createdAt: '2026-08-16T00:00:00.000Z', sizeBytes: 1234, updatedAt: null },
        ],
      };
      await renderWithRouter(<ArtifactsPage />);

      await waitFor(() => {
        expect(screen.getByText('My Dashboard')).toBeTruthy();
      });
      expect(screen.getByText('1.2 KB')).toBeTruthy();

      listResponse = {
        artifacts: [
          { id: 'artifact-1', title: 'My Dashboard', createdAt: '2026-08-16T00:00:00.000Z', sizeBytes: 5120, updatedAt: '2026-08-21T00:00:00.000Z' },
        ],
      };

      const ws = MockWebSocket.getLastInstance();
      await act(async () => {
        ws?.simulateOpen();
        ws?.simulateMessage(
          JSON.stringify({ type: 'artifact-updated', sessionId: 'some-session', artifactId: 'artifact-1' })
        );
      });

      await waitFor(() => {
        expect(screen.getByText('5.0 KB')).toBeTruthy();
      });
    });

    it('refetches the list when an artifact-deleted message arrives', async () => {
      listResponse = {
        artifacts: [
          { id: 'artifact-1', title: 'My Dashboard', createdAt: '2026-08-16T00:00:00.000Z', sizeBytes: 1234, updatedAt: null },
        ],
      };
      await renderWithRouter(<ArtifactsPage />);

      await waitFor(() => {
        expect(screen.getByText('My Dashboard')).toBeTruthy();
      });

      listResponse = { artifacts: [] };

      const ws = MockWebSocket.getLastInstance();
      await act(async () => {
        ws?.simulateOpen();
        ws?.simulateMessage(
          JSON.stringify({ type: 'artifact-deleted', sessionId: 'some-session', artifactId: 'artifact-1' })
        );
      });

      await waitFor(() => {
        expect(screen.getByText('No artifacts found')).toBeTruthy();
      });
    });
  });
});
