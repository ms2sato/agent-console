import { describe, it, expect, mock, beforeEach, afterEach, afterAll, spyOn } from 'bun:test';
import { screen, cleanup, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithRouter } from '../../../test/renderWithRouter';
import { SessionSidePanels } from '../SessionSidePanels';
import { _reset as resetWebSocket } from '../../../lib/app-websocket';
import { installMockWebSocket } from '../../../test/mock-websocket';
import { artifactKeys } from '../../../lib/query-keys';

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
const TODO_TITLE = 'Confirm the rollout';

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
            { id: 'artifact-1', title: ARTIFACT_TITLE, createdAt: '2026-08-16T00:00:00.000Z', sizeBytes: 1234, updatedAt: null },
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

const STORAGE_KEY = 'agent-console:session-side-panels-v3';

function seedRecord(record: { railOpen: boolean; openSection: string | null }): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
}

const SECTION_HEADER_NAME = /^(Collapse|Expand) (Memo|Todo|Artifacts|Bookmarks)$/;

/** Section header label -> aria-expanded, for the headers currently rendered. */
function headerStates(): Record<string, boolean> {
  const states: Record<string, boolean> = {};
  for (const button of screen.queryAllByRole('button', { name: SECTION_HEADER_NAME })) {
    const label = (button.getAttribute('aria-label') ?? '').replace(/^(Collapse|Expand) /, '');
    states[label] = button.getAttribute('aria-expanded') === 'true';
  }
  return states;
}

function openHeaders(): string[] {
  return Object.entries(headerStates())
    .filter(([, expanded]) => expanded)
    .map(([label]) => label);
}

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

  it('tabs from the collapsed Memo header through the always-visible Edit button to the next section header (Todo), skipping Memo\'s inert body entirely', async () => {
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
    const todoHeader = await screen.findByLabelText('Expand Todo');

    const memoSection = collapsedMemoHeader.closest('.border-b') as HTMLElement;
    const memoBodyWrapper = memoSection.querySelector('div[aria-hidden]') as HTMLElement;
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
    expect(document.activeElement).toBe(todoHeader);
    expect(memoBodyWrapper.getAttribute('inert')).toBe('');
    expect(memoSection.querySelector('.overflow-y-auto')).not.toBe(document.activeElement);
  });

  it('starts with the rail closed (default), then opens with only Memo expanded', async () => {
    await renderWithRouter(<SessionSidePanels sessionId="session-1" />);

    await waitFor(() => expect(screen.getByLabelText('Expand side panel')).toBeTruthy());

    act(() => {
      screen.getByLabelText('Expand side panel').click();
    });

    await waitFor(() => expect(screen.getByText('Hello Memo')).toBeTruthy());
    await waitFor(() => expect(Object.keys(headerStates()).sort()).toEqual(['Artifacts', 'Bookmarks', 'Memo', 'Todo']));
    expect(openHeaders()).toEqual(['Memo']);
  });

  it('mounts the to-do section in the open rail when the session has an open item, and leaves it out otherwise', async () => {
    const base = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      if (urlToString(input).includes('/todos')) {
        return Promise.resolve(jsonResponse({ todos: [{
        id: 'todo-1', kind: 'action', scope: 'session', title: TODO_TITLE, body: '', sessionId: 'session-1',
        createdBy: { workerId: 'worker-1' }, assigneeUserId: null, status: 'open', resolutionText: null,
        resolvedByUserId: null, resolvedByWorkerId: null, resolvedAt: null, commentCount: 0, createdAt: '2026-10-15T00:00:00.000Z', updatedAt: '2026-10-15T00:00:00.000Z',
      }] }));
      }
      return base(input);
    });
    seedRecord({ railOpen: true, openSection: 'todos' });

    await renderWithRouter(<SessionSidePanels sessionId="session-1" />);

    expect(await screen.findByText('Todo (1)')).toBeTruthy();
    expect(screen.getByText(TODO_TITLE)).toBeTruthy();
  });

  it('renders the to-do section with a zero count and the New Todo button when the session list settles empty', async () => {
    const base = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation((input: RequestInfo | URL) =>
      urlToString(input).includes('/todos') ? Promise.resolve(jsonResponse({ todos: [] })) : base(input)
    );
    seedRecord({ railOpen: true, openSection: 'todos' });

    await renderWithRouter(<SessionSidePanels sessionId="session-1" />);

    await waitFor(() => expect(screen.getByText(BOOKMARK_TITLE)).toBeTruthy());
    expect(await screen.findByText('Todo (0)')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New Todo' })).toBeTruthy();
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

  it('clicking a compact section label on the closed rail opens the rail with only that section expanded', async () => {
    seedRecord({ railOpen: false, openSection: 'memo' });
    await renderWithRouter(<SessionSidePanels sessionId="session-1" />);
    await waitFor(() => expect(screen.getByLabelText('Expand side panel')).toBeTruthy());
    await screen.findByLabelText('Expand artifacts');

    act(() => {
      screen.getByLabelText('Expand artifacts').click();
    });

    await waitFor(() => expect(screen.getByLabelText('Collapse side panel')).toBeTruthy());
    await waitFor(() => expect(Object.keys(headerStates()).length).toBe(4));
    expect(openHeaders()).toEqual(['Artifacts']);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify({ railOpen: true, openSection: 'artifacts' }));
  });

  it('a label click on the closed rail for the section that is already the open one keeps it open', async () => {
    seedRecord({ railOpen: false, openSection: 'memo' });
    await renderWithRouter(<SessionSidePanels sessionId="session-1" />);
    await screen.findByLabelText('Expand memo');

    act(() => {
      screen.getByLabelText('Expand memo').click();
    });

    await waitFor(() => expect(Object.keys(headerStates()).length).toBe(4));
    expect(openHeaders()).toEqual(['Memo']);
  });

  it('opening Todo while Memo is open leaves exactly one header with aria-expanded="true"', async () => {
    seedRecord({ railOpen: true, openSection: 'memo' });
    await renderWithRouter(<SessionSidePanels sessionId="session-1" />);
    await waitFor(() => expect(Object.keys(headerStates()).length).toBe(4));
    expect(openHeaders()).toEqual(['Memo']);

    act(() => {
      screen.getByLabelText('Expand Todo').click();
    });

    await waitFor(() => expect(openHeaders()).toEqual(['Todo']));
    expect(localStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify({ railOpen: true, openSection: 'todos' }));
  });

  it('clicking the open section header closes it and no section is open', async () => {
    seedRecord({ railOpen: true, openSection: 'memo' });
    await renderWithRouter(<SessionSidePanels sessionId="session-1" />);
    await waitFor(() => expect(Object.keys(headerStates()).length).toBe(4));

    act(() => {
      screen.getByLabelText('Collapse Memo').click();
    });

    await waitFor(() => expect(openHeaders()).toEqual([]));
    expect(localStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify({ railOpen: true, openSection: null }));
  });

  it('collapsing and reopening the rail shows the section that was open', async () => {
    seedRecord({ railOpen: true, openSection: 'bookmarks' });
    await renderWithRouter(<SessionSidePanels sessionId="session-1" />);
    await waitFor(() => expect(screen.getByLabelText('Collapse side panel')).toBeTruthy());

    act(() => {
      screen.getByLabelText('Collapse side panel').click();
    });
    await waitFor(() => expect(screen.getByLabelText('Expand side panel')).toBeTruthy());
    act(() => {
      screen.getByLabelText('Expand side panel').click();
    });

    await waitFor(() => expect(Object.keys(headerStates()).length).toBe(4));
    expect(openHeaders()).toEqual(['Bookmarks']);
  });

  it('the scrolling element holds the four section headers and not the collapse button; the rail root does not scroll', async () => {
    seedRecord({ railOpen: true, openSection: 'memo' });
    const { container } = await renderWithRouter(<SessionSidePanels sessionId="session-1" />);
    await waitFor(() => expect(Object.keys(headerStates()).length).toBe(4));

    const collapse = screen.getByLabelText('Collapse side panel');
    const scroller = container.querySelector('.overflow-y-auto.flex-1') as HTMLElement;
    expect(scroller).toBeTruthy();
    for (const name of ['Collapse Memo', 'Expand Todo', 'Expand Artifacts', 'Expand Bookmarks']) {
      expect(scroller.contains(screen.getByLabelText(name))).toBe(true);
    }
    expect(scroller.contains(collapse)).toBe(false);
    // Sections must not shrink inside the scroller, or they clip instead of scrolling (layout is checked in Browser QA).
    expect(scroller.className).toContain('[&>*]:shrink-0');

    const root = container.querySelector('.w-80') as HTMLElement;
    expect(root.className).not.toContain('overflow-y-auto');
    expect(collapse.closest('.shrink-0')).toBeTruthy();
  });

  it('Memo Edit while another section is open makes Memo the only open section and focuses the textarea', async () => {
    seedRecord({ railOpen: true, openSection: 'bookmarks' });
    await renderWithRouter(<SessionSidePanels sessionId="session-1" />);
    const edit = await screen.findByLabelText('Edit memo');
    await waitFor(() => expect(openHeaders()).toEqual(['Bookmarks']));

    act(() => {
      edit.click();
    });

    await waitFor(() => expect(openHeaders()).toEqual(['Memo']));
    const textarea = (await screen.findByLabelText('Memo content')) as HTMLTextAreaElement;
    expect(document.activeElement).toBe(textarea);
  });

  it('Memo collapsed by another section while editing reads "Memo (editing)" and keeps the draft', async () => {
    seedRecord({ railOpen: true, openSection: 'memo' });
    const user = userEvent.setup();
    await renderWithRouter(<SessionSidePanels sessionId="session-1" />);
    await user.click(await screen.findByLabelText('Edit memo'));
    const textarea = (await screen.findByLabelText('Memo content')) as HTMLTextAreaElement;
    await user.type(textarea, ' typed');
    const draft = textarea.value;

    await user.click(screen.getByLabelText('Expand Todo'));

    const header = await screen.findByLabelText('Expand Memo');
    expect(header.textContent).toContain('Memo (editing)');
    await user.click(header);
    expect((screen.getByLabelText('Memo content') as HTMLTextAreaElement).value).toBe(draft);
    expect(screen.getByLabelText('Collapse Memo').textContent).not.toContain('(editing)');
  });

  it('Bookmarks form text survives another section opening and the form is still showing on reopen', async () => {
    seedRecord({ railOpen: true, openSection: 'bookmarks' });
    const user = userEvent.setup();
    await renderWithRouter(<SessionSidePanels sessionId="session-1" />);
    await user.click(await screen.findByLabelText('Show add bookmark form'));
    await user.type(screen.getByLabelText('Bookmark URL'), 'https://typed.example');

    await user.click(screen.getByLabelText('Expand Memo'));
    await waitFor(() => expect(openHeaders()).toEqual(['Memo']));
    await user.click(screen.getByLabelText('Expand Bookmarks'));

    await waitFor(() => expect(openHeaders()).toEqual(['Bookmarks']));
    expect((screen.getByLabelText('Bookmark URL') as HTMLInputElement).value).toBe('https://typed.example');
    expect(screen.getByLabelText('Hide add bookmark form')).toBeTruthy();
  });

  it('Bookmarks form closed by its own header is hidden on reopen', async () => {
    seedRecord({ railOpen: true, openSection: 'bookmarks' });
    const user = userEvent.setup();
    await renderWithRouter(<SessionSidePanels sessionId="session-1" />);
    await user.click(await screen.findByLabelText('Show add bookmark form'));
    await user.click(screen.getByLabelText('Collapse Bookmarks'));
    await user.click(screen.getByLabelText('Expand Bookmarks'));

    expect(screen.queryByLabelText('Bookmark URL')).toBeNull();
  });

  describe('openSection pointing at a section that renders nothing (empty Artifacts)', () => {
    function routeEmptyArtifacts(): void {
      const base = mockFetch.getMockImplementation()!;
      mockFetch.mockImplementation((input: RequestInfo | URL) =>
        urlToString(input).includes('/artifacts') ? Promise.resolve(jsonResponse({ artifacts: [] })) : base(input)
      );
    }

    it('renders the other three headers collapsed, no Artifacts header, and a click on Memo stores openSection memo', async () => {
      routeEmptyArtifacts();
      seedRecord({ railOpen: true, openSection: 'artifacts' });
      await renderWithRouter(<SessionSidePanels sessionId="session-1" />);

      await waitFor(() => expect(Object.keys(headerStates()).sort()).toEqual(['Bookmarks', 'Memo', 'Todo']));
      expect(headerStates()).toEqual({ Memo: false, Todo: false, Bookmarks: false });
      expect(screen.queryByLabelText('Expand Artifacts')).toBeNull();
      expect(screen.queryByLabelText('Collapse Artifacts')).toBeNull();

      act(() => {
        screen.getByLabelText('Expand Memo').click();
      });

      await waitFor(() => expect(openHeaders()).toEqual(['Memo']));
      expect(JSON.parse(localStorage.getItem(STORAGE_KEY) as string)).toEqual({ railOpen: true, openSection: 'memo' });
    });

    it('when an artifact then arrives, Artifacts renders open and the other three stay closed', async () => {
      routeEmptyArtifacts();
      seedRecord({ railOpen: true, openSection: 'artifacts' });
      const { queryClient } = await renderWithRouter(<SessionSidePanels sessionId="session-1" />);
      await waitFor(() => expect(Object.keys(headerStates()).sort()).toEqual(['Bookmarks', 'Memo', 'Todo']));

      routeFetchByPanel();
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: artifactKeys.listBySession('session-1'), exact: true });
      });

      await waitFor(() => expect(headerStates()).toEqual({ Memo: false, Todo: false, Artifacts: true, Bookmarks: false }));
    });
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
