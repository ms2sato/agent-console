import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import { screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { renderWithRouter } from '../../../test/renderWithRouter';
import { SessionBookmarksPanel } from '../SessionBookmarksPanel';

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

describe('SessionBookmarksPanel', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('renders nothing while the bookmark list is pending', async () => {
    // Never resolves during this test -- still pending.
    mockFetch.mockReturnValue(new Promise(() => {}));

    const { container } = await renderWithRouter(<SessionBookmarksPanel sessionId="session-1" />);

    expect(container.querySelector('[aria-label="Collapse bookmarks"]')).toBeNull();
    expect(container.textContent).toBe('');
  });

  it('renders the add form even when the session has no bookmarks yet', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ bookmarks: [] }));

    await renderWithRouter(<SessionBookmarksPanel sessionId="session-1" />);

    await waitFor(() => expect(screen.getByLabelText('Bookmark URL')).toBeTruthy());
    expect(screen.getByLabelText('Bookmark title')).toBeTruthy();
    expect(screen.getByText('Add bookmark')).toBeTruthy();
  });

  it('renders a bookmark link with rel=noopener noreferrer and target=_blank (S4 navigation safety)', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        bookmarks: [
          { id: 'bookmark-1', url: 'https://example.com', title: 'Example Site', createdAt: '2026-08-20T00:00:00.000Z' },
        ],
      })
    );

    await renderWithRouter(<SessionBookmarksPanel sessionId="session-1" />);

    await waitFor(() => expect(screen.getByText('Example Site')).toBeTruthy());

    const link = screen.getByText('Example Site').closest('a')!;
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe('https://example.com');
    expect(link.getAttribute('target')).toBe('_blank');
    const rel = link.getAttribute('rel') ?? '';
    expect(rel).toContain('noopener');
    expect(rel).toContain('noreferrer');
  });

  it('displays the URL as the label when no title is present', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        bookmarks: [
          { id: 'bookmark-1', url: 'https://example.com/no-title', title: null, createdAt: '2026-08-20T00:00:00.000Z' },
        ],
      })
    );

    await renderWithRouter(<SessionBookmarksPanel sessionId="session-1" />);

    await waitFor(() => expect(screen.getByText('https://example.com/no-title')).toBeTruthy());
  });

  it('renders a malicious title as inert text, not markup (text-node discipline)', async () => {
    const maliciousTitle = '"><script>alert(1)</script>';
    mockFetch.mockResolvedValue(
      jsonResponse({
        bookmarks: [
          { id: 'bookmark-1', url: 'https://example.com', title: maliciousTitle, createdAt: '2026-08-20T00:00:00.000Z' },
        ],
      })
    );

    const { container } = await renderWithRouter(<SessionBookmarksPanel sessionId="session-1" />);

    await waitFor(() => expect(container.textContent).toContain(maliciousTitle));

    // The title must render as an inert text node -- never parsed as markup.
    expect(container.querySelector('script')).toBeNull();
  });

  it('submitting the add form calls the create mutation with the entered url/title', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ bookmarks: [] }));

    await renderWithRouter(<SessionBookmarksPanel sessionId="session-1" />);

    await waitFor(() => expect(screen.getByLabelText('Bookmark URL')).toBeTruthy());

    mockFetch.mockResolvedValue(
      jsonResponse({
        bookmark: { id: 'bookmark-new', url: 'https://example.com', title: 'Example', createdAt: '2026-08-20T00:00:00.000Z' },
      })
    );

    fireEvent.change(screen.getByLabelText('Bookmark URL'), { target: { value: 'https://example.com' } });
    fireEvent.change(screen.getByLabelText('Bookmark title'), { target: { value: 'Example' } });
    fireEvent.click(screen.getByText('Add bookmark'));

    await waitFor(() => {
      const calls = mockFetch.mock.calls as unknown[][];
      const postCall = calls.find((call) => {
        const init = call[1] as { method?: string; body?: string } | undefined;
        return init?.method === 'POST';
      });
      expect(postCall).toBeTruthy();
      const init = postCall![1] as { body: string };
      expect(JSON.parse(init.body)).toEqual({ url: 'https://example.com', title: 'Example', sessionId: 'session-1' });
    });
  });

  it('clicking delete calls the delete mutation with the right id', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        bookmarks: [
          { id: 'bookmark-1', url: 'https://example.com', title: 'Example Site', createdAt: '2026-08-20T00:00:00.000Z' },
        ],
      })
    );

    await renderWithRouter(<SessionBookmarksPanel sessionId="session-1" />);
    await waitFor(() => expect(screen.getByText('Example Site')).toBeTruthy());

    mockFetch.mockResolvedValue(jsonResponse({ success: true }));

    fireEvent.click(screen.getByLabelText('Delete bookmark Example Site'));

    await waitFor(() => {
      const calls = mockFetch.mock.calls as unknown[][];
      const deleteCall = calls.find((call) => {
        const init = call[1] as { method?: string } | undefined;
        return init?.method === 'DELETE';
      });
      expect(deleteCall).toBeTruthy();
      const url = deleteCall![0];
      const urlStr = typeof url === 'string' ? url : url instanceof Request ? url.url : String(url);
      expect(urlStr).toContain('/api/bookmarks/bookmark-1');
    });
  });

  it('collapses to a thin strip and can be re-expanded', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        bookmarks: [
          { id: 'bookmark-1', url: 'https://example.com', title: 'Example Site', createdAt: '2026-08-20T00:00:00.000Z' },
        ],
      })
    );

    await renderWithRouter(<SessionBookmarksPanel sessionId="session-1" />);
    await waitFor(() => expect(screen.getByText('Example Site')).toBeTruthy());

    screen.getByLabelText('Collapse bookmarks').click();

    await waitFor(() => expect(screen.getByLabelText('Expand bookmarks')).toBeTruthy());
    expect(screen.queryByText('Example Site')).toBeNull();

    screen.getByLabelText('Expand bookmarks').click();
    await waitFor(() => expect(screen.getByText('Example Site')).toBeTruthy());
  });
});
