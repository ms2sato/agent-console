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

/**
 * Measured reach, recorded by WHICH test failed (standing rule). Each mutation
 * was applied to `SessionBookmarksPanel.tsx` and the whole file re-run:
 *
 *   m1  `isExpanded` back to `useState(true)` -- the old default
 *       -> 18 of 19 fail. Not a narrow pin: with the panel open by default,
 *          every test that expands first finds no "Expand bookmarks" button.
 *          This is the polarity check for the change's headline behaviour.
 *   m2  `isFormVisible` initial `true` -- the form resident again
 *       -> 3 fail: the submit test, the continuous-adding pin, and the
 *          collapse-resets-the-form pin.
 *   m3  drop `urlInputRef.current?.focus()` on success
 *       -> 1 fail, alone: the continuous-adding pin. Nothing else notices,
 *          because a cleared-but-blurred form looks identical in the DOM.
 *          That assertion is the only thing standing between "stays open"
 *          and "stays open and is unusable".
 *   m4  collapsing no longer resets `isFormVisible`
 *       -> 1 fail, alone: the collapse-resets pin.
 *   m5  the reveal button sets `true` instead of toggling
 *       -> 1 fail, alone: the toggle pin.
 *
 * A note on measuring this, since it cost a wrong conclusion once: an earlier
 * harness grepped `^✗` and reported m3/m4/m5 as killing NOTHING. The marker is
 * not always at line start -- interleaved runner output precedes it -- so the
 * three pins that each catch exactly one mutation looked inert. Match the
 * marker anywhere in the line, and confirm a mutation applied before trusting
 * a zero.
 */
/**
 * The panel starts collapsed and the add form starts hidden, so nothing below
 * can query content without first saying how it got on screen. That is the
 * point of these two helpers: a test that used to assert "the form is visible"
 * now has to spell out the action that revealed it.
 */
async function expandPanel(): Promise<void> {
  fireEvent.click(await screen.findByLabelText('Expand bookmarks'));
  await waitFor(() => expect(screen.getByLabelText('Collapse bookmarks')).toBeTruthy());
}

async function revealAddForm(): Promise<void> {
  fireEvent.click(await screen.findByLabelText('Show add bookmark form'));
  await waitFor(() => expect(screen.getByLabelText('Bookmark URL')).toBeTruthy());
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

    // Reachable, not resident: the form exists behind two deliberate actions
    // even with an empty list, which is what keeps the first bookmark
    // addable by hand.
    await expandPanel();
    expect(screen.queryByLabelText('Bookmark URL')).toBeNull();
    await revealAddForm();
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
    await expandPanel();

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
    await expandPanel();

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
    await expandPanel();

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
    await expandPanel();

    await waitFor(() => expect(container.textContent).toContain(maliciousTitle));

    // The title must render as an inert text node -- never parsed as markup.
    expect(container.querySelector('script')).toBeNull();
  });

  it('submitting the add form calls the create mutation with the entered url/title and refreshes the list', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ bookmarks: [] }));

    await renderWithRouter(<SessionBookmarksPanel sessionId="session-1" />);
    await expandPanel();
    await revealAddForm();

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

  it('after a successful submit the form stays open, the inputs are cleared, and focus is back in the URL input', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ bookmarks: [] }));

    await renderWithRouter(<SessionBookmarksPanel sessionId="session-1" />);
    await expandPanel();
    await revealAddForm();

    const added = {
      id: 'bookmark-new',
      url: 'https://example.com',
      title: 'Example',
      createdAt: '2026-08-20T00:00:00.000Z',
      origin: 'user',
    };
    mockFetch.mockResolvedValueOnce(jsonResponse({ bookmark: added }));
    mockFetch.mockResolvedValueOnce(jsonResponse({ bookmarks: [added] }));

    fireEvent.change(screen.getByLabelText('Bookmark URL'), { target: { value: 'https://example.com' } });
    fireEvent.change(screen.getByLabelText('Bookmark title'), { target: { value: 'Example' } });
    fireEvent.click(screen.getByText('Add bookmark'));

    await waitFor(() => expect(screen.getByText('Example')).toBeTruthy());

    // Adding several in a row is the reason the form does not close. All three
    // are required for that: still open, empty, and focused. Cleared-but-blurred
    // would send the next keystroke nowhere and look identical in a snapshot.
    const urlInput = screen.getByLabelText('Bookmark URL') as HTMLInputElement;
    expect(urlInput).toBeTruthy();
    expect(urlInput.value).toBe('');
    expect((screen.getByLabelText('Bookmark title') as HTMLInputElement).value).toBe('');
    expect(document.activeElement).toBe(urlInput);
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
    await expandPanel();
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

  it('starts collapsed: the list is not on screen until the panel is expanded', async () => {
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

    // The default, asserted before anything is clicked. This is the case that
    // fails against the old `useState(true)`.
    await waitFor(() => expect(screen.getByLabelText('Expand bookmarks')).toBeTruthy());
    expect(screen.queryByLabelText('Collapse bookmarks')).toBeNull();
    expect(screen.queryByText('Example Site')).toBeNull();
    expect(screen.queryByLabelText('Bookmark URL')).toBeNull();

    await expandPanel();
    expect(screen.getByText('Example Site')).toBeTruthy();
  });

  it('the add form is hidden until its button is pressed, and the button toggles it back', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ bookmarks: [] }));

    await renderWithRouter(<SessionBookmarksPanel sessionId="session-1" />);
    await expandPanel();

    // Expanded is not enough -- the form needs its own action.
    expect(screen.queryByLabelText('Bookmark URL')).toBeNull();

    await revealAddForm();
    expect(screen.getByLabelText('Bookmark URL')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Hide add bookmark form'));
    await waitFor(() => expect(screen.queryByLabelText('Bookmark URL')).toBeNull());
    // The way back in is still there.
    expect(screen.getByLabelText('Show add bookmark form')).toBeTruthy();
  });

  it('collapsing the panel resets the form to hidden, so re-expanding does not restore it', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ bookmarks: [] }));

    await renderWithRouter(<SessionBookmarksPanel sessionId="session-1" />);
    await expandPanel();
    await revealAddForm();

    fireEvent.click(screen.getByLabelText('Collapse bookmarks'));
    await waitFor(() => expect(screen.getByLabelText('Expand bookmarks')).toBeTruthy());

    await expandPanel();
    // Re-expanded, and the form is NOT still open from before the collapse.
    expect(screen.queryByLabelText('Bookmark URL')).toBeNull();
    expect(screen.getByLabelText('Show add bookmark form')).toBeTruthy();
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
    await expandPanel();
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
    await expandPanel();

    await waitFor(() => expect(screen.getByText('Example Site')).toBeTruthy());

    const link = screen.getByText('Example Site').closest('a')!;
    // The host string is not part of the anchor's own text content...
    expect(link.textContent).toBe('Example Site');
    // ...but it is present elsewhere in the DOM, as its own text node.
    const hostNode = screen.getByText('example.com');
    expect(link.contains(hostNode)).toBe(false);
  });

  it('wraps the host line instead of clipping it, even for an attacker-controlled long host (structural pin)', async () => {
    // A maliciously long, unbroken host (up to 253 chars via many DNS
    // labels) must wrap across lines rather than overflow -- an ellipsis or
    // any other clipping would hide the host's true suffix, defeating P4's
    // "host is visible at click time" guarantee via a different mechanism
    // than title-crowding (design doc §7). happy-dom does not lay out CSS,
    // so this test pins the *class*, not actual visual wrapping.
    const longLabel = 'a'.repeat(63);
    const longHost = `github.com.${longLabel}.${longLabel}.${longLabel}.attacker.example`;
    mockFetch.mockResolvedValue(
      jsonResponse({
        bookmarks: [
          {
            id: 'bookmark-1',
            url: `https://${longHost}/`,
            title: 'Long Host Bookmark',
            createdAt: '2026-08-20T00:00:00.000Z',
            origin: 'user',
          },
        ],
      })
    );

    await renderWithRouter(<SessionBookmarksPanel sessionId="session-1" />);
    await expandPanel();

    await waitFor(() => expect(screen.getByText('Long Host Bookmark')).toBeTruthy());

    const hostNode = screen.getByText(longHost);
    expect(hostNode.className).toContain('break-all');
    expect(hostNode.className).not.toContain('truncate');
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
    await expandPanel();

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
    await expandPanel();

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
    await expandPanel();

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
    await expandPanel();

    await waitFor(() => expect(screen.getByText('IDN Example')).toBeTruthy());
    const expectedHost = new URL('https://пример.рф/').host;
    expect(expectedHost).toMatch(/^xn--/);
    expect(screen.getByText(expectedHost)).toBeTruthy();
    expect(screen.queryByText('пример.рф')).toBeNull();
  });
});
