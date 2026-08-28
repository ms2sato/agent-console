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
          {
            id: 'bookmark-1',
            url: 'https://example.com',
            title: 'Example Site',
            createdAt: '2026-08-20T00:00:00.000Z',
            origin: 'user',
          },
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
          {
            id: 'bookmark-1',
            url: 'https://example.com/no-title',
            title: null,
            createdAt: '2026-08-20T00:00:00.000Z',
            origin: 'user',
          },
        ],
      })
    );

    await renderWithRouter(<SessionBookmarksPanel sessionId="session-1" />);

    await waitFor(() => expect(screen.getByText('https://example.com/no-title')).toBeTruthy());
  });

  it('a null title still shows a host line alongside the URL-as-label anchor (design doc §7)', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        bookmarks: [
          {
            id: 'bookmark-1',
            url: 'https://example.com/no-title',
            title: null,
            createdAt: '2026-08-20T00:00:00.000Z',
            origin: 'user',
          },
        ],
      })
    );

    await renderWithRouter(<SessionBookmarksPanel sessionId="session-1" />);

    await waitFor(() => expect(screen.getByText('https://example.com/no-title')).toBeTruthy());
    // Coexistence, not either/or: the host line renders even though the
    // anchor's own text already happens to be the URL.
    expect(screen.getByText('example.com')).toBeTruthy();
  });

  it('renders a malicious title as inert text, not markup (text-node discipline)', async () => {
    const maliciousTitle = '"><script>alert(1)</script>';
    mockFetch.mockResolvedValue(
      jsonResponse({
        bookmarks: [
          {
            id: 'bookmark-1',
            url: 'https://example.com',
            title: maliciousTitle,
            createdAt: '2026-08-20T00:00:00.000Z',
            origin: 'user',
          },
        ],
      })
    );

    const { container } = await renderWithRouter(<SessionBookmarksPanel sessionId="session-1" />);

    await waitFor(() => expect(container.textContent).toContain(maliciousTitle));

    // The title must render as an inert text node -- never parsed as markup.
    expect(container.querySelector('script')).toBeNull();
  });

  it('submitting the add form calls the create mutation with the entered url/title and refreshes the list', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ bookmarks: [] }));

    await renderWithRouter(<SessionBookmarksPanel sessionId="session-1" />);

    await waitFor(() => expect(screen.getByLabelText('Bookmark URL')).toBeTruthy());

    const newBookmark = {
      id: 'bookmark-new',
      url: 'https://example.com',
      title: 'Example',
      createdAt: '2026-08-20T00:00:00.000Z',
      origin: 'user',
    };
    // The POST response and the invalidated query's GET refetch are two
    // distinct calls with different response shapes -- queue them
    // separately so the refetch doesn't receive the POST's `{ bookmark }`
    // shape (which fails BookmarksListResponseSchema parsing).
    mockFetch.mockResolvedValueOnce(jsonResponse({ bookmark: newBookmark }));
    mockFetch.mockResolvedValueOnce(jsonResponse({ bookmarks: [newBookmark] }));

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

    // The invalidated query's refetch brings the new bookmark into the list.
    await waitFor(() => expect(screen.getByText('Example')).toBeTruthy());
  });

  it('clicking delete calls the delete mutation with the right id and refreshes the list', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        bookmarks: [
          {
            id: 'bookmark-1',
            url: 'https://example.com',
            title: 'Example Site',
            createdAt: '2026-08-20T00:00:00.000Z',
            origin: 'user',
          },
        ],
      })
    );

    await renderWithRouter(<SessionBookmarksPanel sessionId="session-1" />);
    await waitFor(() => expect(screen.getByText('Example Site')).toBeTruthy());

    // Same reasoning as the add-form test above: queue the DELETE response
    // and the invalidated query's GET refetch separately.
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true }));
    mockFetch.mockResolvedValueOnce(jsonResponse({ bookmarks: [] }));

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

    // The invalidated query's refetch removes the deleted bookmark from the list.
    await waitFor(() => expect(screen.queryByText('Example Site')).toBeNull());
  });

  it('collapses to a thin strip and can be re-expanded', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        bookmarks: [
          {
            id: 'bookmark-1',
            url: 'https://example.com',
            title: 'Example Site',
            createdAt: '2026-08-20T00:00:00.000Z',
            origin: 'user',
          },
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

  it('renders the host as a separate DOM node, not inside the title anchor (design doc §7)', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        bookmarks: [
          {
            id: 'bookmark-1',
            url: 'https://example.com/some/path',
            title: 'Example Site',
            createdAt: '2026-08-20T00:00:00.000Z',
            origin: 'user',
          },
        ],
      })
    );

    await renderWithRouter(<SessionBookmarksPanel sessionId="session-1" />);

    await waitFor(() => expect(screen.getByText('Example Site')).toBeTruthy());

    const link = screen.getByText('Example Site').closest('a')!;
    // The host string is not part of the anchor's own text content...
    expect(link.textContent).toBe('Example Site');
    // ...but it is present elsewhere in the DOM, as its own text node.
    const hostNode = screen.getByText('example.com');
    expect(link.contains(hostNode)).toBe(false);
  });

  it('derives the host from the URL, not from a title containing a fake host string', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        bookmarks: [
          {
            id: 'bookmark-1',
            url: 'https://evil.example/phish',
            title: 'Login - github.com',
            createdAt: '2026-08-20T00:00:00.000Z',
            origin: 'user',
          },
        ],
      })
    );

    await renderWithRouter(<SessionBookmarksPanel sessionId="session-1" />);

    await waitFor(() => expect(screen.getByText('Login - github.com')).toBeTruthy());

    // The computed host must read the real destination, never the
    // registrant-supplied fake host string embedded in the title.
    expect(screen.getByText('evil.example')).toBeTruthy();
    expect(screen.queryByText('github.com')).toBeNull();
  });

  it('shows the origin badge only for agent-registered bookmarks', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        bookmarks: [
          {
            id: 'bookmark-agent',
            url: 'https://example.com',
            title: 'Agent Bookmark',
            createdAt: '2026-08-20T00:00:00.000Z',
            origin: 'agent',
          },
          {
            id: 'bookmark-user',
            url: 'https://example.org',
            title: 'User Bookmark',
            createdAt: '2026-08-20T00:00:00.000Z',
            origin: 'user',
          },
        ],
      })
    );

    await renderWithRouter(<SessionBookmarksPanel sessionId="session-1" />);

    await waitFor(() => expect(screen.getByText('Agent Bookmark')).toBeTruthy());
    expect(screen.getByText('User Bookmark')).toBeTruthy();

    const badges = screen.getAllByLabelText('Registered by an agent');
    expect(badges).toHaveLength(1);
  });

  it('leaves the host node present in the DOM even with a very long title', async () => {
    const longTitle = 'A'.repeat(160);
    mockFetch.mockResolvedValue(
      jsonResponse({
        bookmarks: [
          {
            id: 'bookmark-1',
            url: 'https://example.com',
            title: longTitle,
            createdAt: '2026-08-20T00:00:00.000Z',
            origin: 'user',
          },
        ],
      })
    );

    await renderWithRouter(<SessionBookmarksPanel sessionId="session-1" />);

    await waitFor(() => expect(screen.getByText(longTitle)).toBeTruthy());
    expect(screen.getByText('example.com')).toBeTruthy();
  });

  it('renders an IDN host in its Punycode ASCII form, not the raw Unicode', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        bookmarks: [
          {
            id: 'bookmark-1',
            url: 'https://пример.рф/',
            title: 'IDN Example',
            createdAt: '2026-08-20T00:00:00.000Z',
            origin: 'user',
          },
        ],
      })
    );

    await renderWithRouter(<SessionBookmarksPanel sessionId="session-1" />);

    await waitFor(() => expect(screen.getByText('IDN Example')).toBeTruthy());
    const expectedHost = new URL('https://пример.рф/').host;
    expect(expectedHost).toMatch(/^xn--/);
    expect(screen.getByText(expectedHost)).toBeTruthy();
    expect(screen.queryByText('пример.рф')).toBeNull();
  });
});
