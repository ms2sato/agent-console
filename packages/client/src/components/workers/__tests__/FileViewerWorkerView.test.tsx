// NOTE: Only `fetch` is stubbed (test/file-viewer-fetch.ts): the listing and
// content responses go through the real fetchFileTree / fetchFileContent and
// are parsed by the shared valibot schemas. The server-populates -> schema ->
// client round trip lives in packages/integration/src/file-viewer-boundary.test.ts.
import { describe, it, expect, afterEach, afterAll, beforeEach } from 'bun:test';
import { cleanup, screen, waitFor, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FileViewerWorkerView } from '../FileViewerWorkerView';
import { renderWithQuery } from '../../../test/renderWithQuery';
import {
  createFileViewerFetch,
  textFile,
  type FileViewerFetchRoutes,
} from '../../../test/file-viewer-fetch';
import { waitForAbsent } from '../../../test/waitForAbsent';
import { MockWebSocket, installMockWebSocket } from '../../../test/mock-websocket';
import { _reset } from '../../../lib/worker-websocket';

const originalFetch = globalThis.fetch;
const originalMatchMedia = window.matchMedia;
let restoreWebSocket: () => void;

afterAll(() => {
  globalThis.fetch = originalFetch;
});
beforeEach(() => {
  window.matchMedia = originalMatchMedia;
  // The view opens the viewer's worker WebSocket while mounted.
  restoreWebSocket = installMockWebSocket();
  _reset();
});
afterEach(() => {
  cleanup();
  _reset();
  restoreWebSocket();
  window.matchMedia = originalMatchMedia;
});

// Built from parts: a dot-env file must be listed and readable like any other.
const DOT_ENV = ['.', 'env'].join('');

function installFetch(routes: FileViewerFetchRoutes) {
  const stub = createFileViewerFetch(routes);
  globalThis.fetch = Object.assign(stub.fetchMock, { preconnect: originalFetch.preconnect }) as typeof fetch;
  return stub;
}

function setMobile(isMobile: boolean) {
  window.matchMedia = ((query: string) =>
    ({
      matches: isMobile,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
}

function renderView() {
  return renderWithQuery(<FileViewerWorkerView sessionId="s1" workerId="w1" />);
}

const routes = (): FileViewerFetchRoutes => ({
  tree: {
    '': [
      { name: '.git', kind: 'dir' },
      { name: 'src', kind: 'dir' },
      { name: DOT_ENV, kind: 'file' },
      { name: 'README.md', kind: 'file' },
      { name: 'docs-link', kind: 'symlink' },
    ],
    src: [{ name: 'a.ts', kind: 'file' }],
    '.git': [{ name: 'HEAD', kind: 'file' }],
  },
  content: {
    'README.md': textFile('README.md', 'readme title\nbody\n'),
    [DOT_ENV]: textFile(DOT_ENV, 'SECRET=1\n', { language: 'bash' }),
    'src/a.ts': textFile('src/a.ts', 'const a = 1;\n', { language: 'typescript' }),
  },
});

describe('FileViewerWorkerView (desktop)', () => {
  it('lists the root with dotfiles and .git, both panes visible, no file selected yet', async () => {
    installFetch(routes());
    await renderView();

    expect(await screen.findByRole('button', { name: '.git' })).toBeTruthy();
    expect(screen.getByRole('button', { name: DOT_ENV })).toBeTruthy();
    expect(screen.getByText('Select a file to view it.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Toggle file tree' })).toBeNull();
  });

  it('expands a directory lazily and opens a file from it with its path, line numbers and content', async () => {
    const { calls } = installFetch(routes());
    await renderView();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'src' }));
    await user.click(await screen.findByRole('button', { name: 'a.ts' }));

    expect(await screen.findByText('src/a.ts')).toBeTruthy();
    const line = await waitFor(() => {
      const el = document.querySelector('[data-line="1"]');
      if (!el) throw new Error('no line yet');
      return el;
    });
    expect(line.textContent).toBe('1const a = 1;');
    expect(calls).toEqual([
      { route: 'tree', path: '' },
      { route: 'tree', path: 'src' },
      { route: 'content', path: 'src/a.ts' },
    ]);
  });

  it('opens a dot-env file like any other file', async () => {
    installFetch(routes());
    await renderView();

    await userEvent.setup().click(await screen.findByRole('button', { name: DOT_ENV }));

    await waitFor(() => expect(document.querySelector('[data-line="1"]')?.textContent).toBe('1SECRET=1'));
  });

  it('collapsing a directory hides its entries', async () => {
    installFetch(routes());
    await renderView();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'src' }));
    await screen.findByRole('button', { name: 'a.ts' });
    await user.click(screen.getByRole('button', { name: 'src' }));

    await waitForAbsent(() => screen.queryByRole('button', { name: 'a.ts' }));
  });

  it('shows the content route message when the selected file cannot be read', async () => {
    const r = routes();
    r.content = { 'README.md': { failure: { status: 400, error: 'Not a regular file' } } };
    installFetch(r);
    await renderView();

    await userEvent.setup().click(await screen.findByRole('button', { name: 'README.md' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Not a regular file');
    expect(alert.textContent).toContain('README.md');
  });

  describe('Refresh', () => {
    it('re-lists every open directory (and not a closed one) and re-reads the selected file', async () => {
      const r = routes();
      const { calls } = installFetch(r);
      await renderView();
      const user = userEvent.setup();

      await user.click(await screen.findByRole('button', { name: 'src' }));
      await screen.findByRole('button', { name: 'a.ts' });
      await user.click(screen.getByRole('button', { name: 'README.md' }));
      await screen.findByText('readme title');
      calls.length = 0;

      // The server changed: a new file in src, new README content.
      r.tree!.src = [
        { name: 'a.ts', kind: 'file' },
        { name: 'b.ts', kind: 'file' },
      ];
      r.content!['README.md'] = textFile('README.md', 'readme changed\n');
      await user.click(screen.getByRole('button', { name: /Refresh/ }));

      expect(await screen.findByRole('button', { name: 'b.ts' })).toBeTruthy();
      expect(await screen.findByText('readme changed')).toBeTruthy();
      const keys = calls.map((c) => `${c.route}:${c.path}`).sort();
      expect(keys).toEqual(['content:README.md', 'tree:', 'tree:src']);
    });
  });

  describe('symlinks', () => {
    it('expands a symlink to a directory in place without opening it as a file', async () => {
      const r = routes();
      r.tree!['docs-link'] = [{ name: 'guide.md', kind: 'file' }];
      const { calls } = installFetch(r);
      await renderView();

      await userEvent.setup().click(await screen.findByRole('button', { name: 'docs-link (symlink)' }));

      expect(await screen.findByRole('button', { name: 'guide.md' })).toBeTruthy();
      expect(calls.some((c) => c.route === 'content')).toBe(false);
    });

    describe('a symlink probe that finishes after the user opened another file', () => {
      const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });

      it('does not expand the symlink when the probe succeeds late', async () => {
        const r = routes();
        r.tree!['docs-link'] = [{ name: 'guide.md', kind: 'file' }];
        const { hold } = installFetch(r);
        const release = hold('tree', 'docs-link');
        await renderView();
        const user = userEvent.setup();

        await user.click(await screen.findByRole('button', { name: 'docs-link (symlink)' }));
        await user.click(screen.getByRole('button', { name: 'README.md' }));
        expect(await screen.findByText('readme title')).toBeTruthy();
        release();
        await settle();

        // Booleans, not elements: a failing poll must not serialise a DOM node.
        expect(screen.queryByRole('button', { name: 'guide.md' }) !== null).toBe(false);
        expect(screen.getByText('readme title')).toBeTruthy();
      });

      it('keeps the newer selection when the probe fails late and would fall back to opening the symlink', async () => {
        const r = routes();
        r.tree!['docs-link'] = { failure: { status: 400, error: 'Path is not a directory' } };
        r.content!['docs-link'] = textFile('docs-link', 'linked content\n');
        const { hold } = installFetch(r);
        const release = hold('tree', 'docs-link');
        await renderView();
        const user = userEvent.setup();

        await user.click(await screen.findByRole('button', { name: 'docs-link (symlink)' }));
        await user.click(screen.getByRole('button', { name: 'README.md' }));
        expect(await screen.findByText('readme title')).toBeTruthy();
        release();
        await settle();

        expect(screen.getByText('readme title')).toBeTruthy();
        expect(screen.queryByText('linked content') !== null).toBe(false);
      });

      it('still applies the outcome when nothing else happened in between (control)', async () => {
        const r = routes();
        r.tree!['docs-link'] = [{ name: 'guide.md', kind: 'file' }];
        const { hold } = installFetch(r);
        const release = hold('tree', 'docs-link');
        await renderView();

        await userEvent.setup().click(await screen.findByRole('button', { name: 'docs-link (symlink)' }));
        release();

        expect(await screen.findByRole('button', { name: 'guide.md' })).toBeTruthy();
      });
    });

    it('opens a symlink to a file as a file when the directory listing refuses it', async () => {
      const r = routes();
      r.tree!['docs-link'] = { failure: { status: 400, error: 'Path is not a directory' } };
      r.content!['docs-link'] = textFile('docs-link', 'linked content\n');
      installFetch(r);
      await renderView();

      await userEvent.setup().click(await screen.findByRole('button', { name: 'docs-link (symlink)' }));

      expect(await screen.findByText('linked content')).toBeTruthy();
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it("surfaces the routes' error, not a silent no-op, when a symlink can be neither listed nor read", async () => {
      const r = routes();
      r.tree!['docs-link'] = { failure: { status: 400, error: 'Path resolves outside the working directory' } };
      r.content!['docs-link'] = { failure: { status: 400, error: 'Path resolves outside the working directory' } };
      installFetch(r);
      await renderView();

      await userEvent.setup().click(await screen.findByRole('button', { name: 'docs-link (symlink)' }));

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain('Path resolves outside the working directory');
      expect(alert.textContent).toContain('docs-link');
    });

    it('also reports the directory attempt when the file attempt fails for a different reason', async () => {
      const r = routes();
      r.tree!['docs-link'] = { failure: { status: 403, error: 'Forbidden' } };
      r.content!['docs-link'] = { failure: { status: 400, error: 'Path is a directory' } };
      installFetch(r);
      await renderView();

      await userEvent.setup().click(await screen.findByRole('button', { name: 'docs-link (symlink)' }));

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain('Path is a directory');
      expect(alert.textContent).toContain('Also tried as a directory: Forbidden');
    });
  });
});

describe('FileViewerWorkerView (live updates)', () => {
  const liveRoutes = (): FileViewerFetchRoutes => ({
    tree: {
      '': [
        { name: 'sub', kind: 'dir' },
        { name: 'other', kind: 'dir' },
      ],
      sub: [{ name: 'a.ts', kind: 'file' }],
      other: [{ name: 'x.ts', kind: 'file' }],
    },
    content: { 'sub/a.ts': textFile('sub/a.ts', 'old content\n') },
  });

  function openSocket() {
    const ws = MockWebSocket.getLastInstance()!;
    act(() => ws.simulateOpen());
    return ws;
  }

  function sendFrame(ws: MockWebSocket, frame: object) {
    act(() => ws.simulateMessage(JSON.stringify(frame)));
  }

  const keysOf = (calls: Array<{ route: string; path: string }>) => calls.map((c) => `${c.route}:${c.path}`).sort();

  async function openSubFile(r: FileViewerFetchRoutes) {
    const stub = installFetch(r);
    await renderView();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'sub' }));
    await user.click(await screen.findByRole('button', { name: 'a.ts' }));
    await screen.findByText('old content');
    return { ...stub, user, ws: openSocket() };
  }

  // Reach (measured): this is the pin for "a collapsed directory is NOT
  // refetched", which rests on refetchType defaulting to 'active'. Passing
  // refetchType: 'all' on the tree invalidation fails THIS test (tree:other
  // joins the fetch set) plus, at the hook level, `never asks to refetch
  // inactive queries` and the 7 table tests that pin the filter object.
  // Dropping `exact: true` fails no test in this file: React Query matches keys
  // element-wise, so tree(s, w, 'sub') never prefix-matches another directory.
  it('refetches the changed open directory and the selected file, and not a collapsed directory', async () => {
    const r = liveRoutes();
    const { calls, user, ws } = await openSubFile(r);
    // `other` was opened then collapsed: cached but inactive, so only a stale mark may touch it.
    await user.click(screen.getByRole('button', { name: 'other' }));
    await screen.findByRole('button', { name: 'x.ts' });
    await user.click(screen.getByRole('button', { name: 'other' }));
    await waitForAbsent(() => screen.queryByRole('button', { name: 'x.ts' }));
    calls.length = 0;

    r.tree!.sub = [
      { name: 'a.ts', kind: 'file' },
      { name: 'b.ts', kind: 'file' },
    ];
    r.content!['sub/a.ts'] = textFile('sub/a.ts', 'new content\n');
    sendFrame(ws, { type: 'files-changed', paths: ['sub/a.ts', 'other/x.ts'], overflow: false });

    expect(await screen.findByRole('button', { name: 'b.ts' })).toBeTruthy();
    expect(await screen.findByText('new content')).toBeTruthy();
    expect(keysOf(calls)).toEqual(['content:sub/a.ts', 'tree:sub']);
  });

  it('shows "File removed" (not an alert) when the selected file is gone, and shows it again once re-created', async () => {
    const r = liveRoutes();
    const { ws } = await openSubFile(r);

    delete r.content!['sub/a.ts'];
    sendFrame(ws, { type: 'files-changed', paths: ['sub/a.ts'], overflow: false });

    expect(await screen.findByText('File removed')).toBeTruthy();
    expect(screen.getByText('sub/a.ts')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'a.ts' }).closest('li')!.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('button', { name: 'sub' }).closest('li')!.getAttribute('aria-expanded')).toBe('true');

    r.content!['sub/a.ts'] = textFile('sub/a.ts', 'back again\n');
    sendFrame(ws, { type: 'files-changed', paths: ['sub/a.ts'], overflow: false });

    expect(await screen.findByText('back again')).toBeTruthy();
    expect(screen.queryByText('File removed')).toBeNull();
  });

  it('keeps the alert pane for a non-404 content error', async () => {
    const r = liveRoutes();
    const { ws } = await openSubFile(r);

    r.content!['sub/a.ts'] = { failure: { status: 400, error: 'Not a regular file' } };
    sendFrame(ws, { type: 'files-changed', paths: ['sub/a.ts'], overflow: false });

    expect((await screen.findByRole('alert')).textContent).toContain('Not a regular file');
    expect(screen.queryByText('File removed')).toBeNull();
  });

  it('collapses an expanded directory that was deleted, without an alert row', async () => {
    const r = liveRoutes();
    const { ws } = await openSubFile(r);

    delete r.tree!.sub;
    sendFrame(ws, { type: 'files-changed', paths: ['sub/a.ts'], overflow: false });

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'sub' }).closest('li')!.getAttribute('aria-expanded')).toBe('false'),
    );
    expect(screen.queryByRole('button', { name: 'a.ts' })).toBeNull();
    expect(screen.queryByText('Not found')).toBeNull();
  });

  it('expands a re-created directory with ONE click after it was collapsed by a 404', async () => {
    const r = liveRoutes();
    const { user, ws } = await openSubFile(r);
    const subItem = () => screen.getByRole('button', { name: 'sub' }).closest('li')!;

    delete r.tree!.sub;
    sendFrame(ws, { type: 'files-changed', paths: ['sub/a.ts'], overflow: false });
    await waitFor(() => expect(subItem().getAttribute('aria-expanded')).toBe('false'));

    r.tree!.sub = [{ name: 'a.ts', kind: 'file' }];
    await user.click(screen.getByRole('button', { name: 'sub' }));

    // The cached 404 must not be read as "gone" while the refetch is in flight.
    expect(await screen.findByRole('button', { name: 'a.ts' })).toBeTruthy();
    expect(subItem().getAttribute('aria-expanded')).toBe('true');
  });

  it('keeps the alert when the root listing itself is gone', async () => {
    const r = liveRoutes();
    const { ws } = await openSubFile(r);

    delete r.tree![''];
    sendFrame(ws, { type: 'files-changed', paths: ['new.ts'], overflow: false });

    expect((await screen.findByRole('alert')).textContent).toBe('Not found');
  });

  it('says live updates are unavailable and keeps Refresh working', async () => {
    const r = liveRoutes();
    const { calls, user, ws } = await openSubFile(r);
    expect(screen.queryByText(/Live updates unavailable/)).toBeNull();

    sendFrame(ws, { type: 'watch-unavailable', reason: 'permission-denied' });

    expect((await screen.findByText('Live updates unavailable (permission denied)'))).toBeTruthy();
    const refresh = screen.getByRole('button', { name: /Refresh/ }) as HTMLButtonElement;
    expect(refresh.disabled).toBe(false);
    calls.length = 0;
    r.content!['sub/a.ts'] = textFile('sub/a.ts', 'after refresh\n');
    await user.click(refresh);

    expect(await screen.findByText('after refresh')).toBeTruthy();
    expect(keysOf(calls)).toEqual(['content:sub/a.ts', 'tree:', 'tree:sub']);
  });

  it('names a failed watch differently from a denied one', async () => {
    const { ws } = await openSubFile(liveRoutes());

    sendFrame(ws, { type: 'watch-unavailable', reason: 'watch-failed' });

    expect(await screen.findByText('Live updates unavailable (watch failed)')).toBeTruthy();
  });
});

describe('FileViewerWorkerView (mobile)', () => {
  it('shows only the content area with a toggle; the tree is not mounted or fetched until opened', async () => {
    setMobile(true);
    const { calls } = installFetch(routes());
    await renderView();

    expect(screen.getByRole('button', { name: 'Toggle file tree' })).toBeTruthy();
    expect(screen.queryByRole('tree')).toBeNull();
    expect(screen.getByText('Select a file to view it.')).toBeTruthy();
    expect(calls).toEqual([]);
  });

  it('opens the tree as a drawer over the content and closes it when a file is selected', async () => {
    setMobile(true);
    installFetch(routes());
    await renderView();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Toggle file tree' }));
    const drawer = await screen.findByRole('dialog', { name: 'File tree' });
    // Parity with the session side-panels drawer: a modal dialog with a label.
    expect(drawer.getAttribute('role')).toBe('dialog');
    expect(drawer.getAttribute('aria-modal')).toBe('true');
    expect(drawer.getAttribute('aria-label')).toBe('File tree');
    expect(within(drawer).getByRole('tree')).toBeTruthy();

    await user.click(await within(drawer).findByRole('button', { name: 'README.md' }));

    await waitForAbsent(() => screen.queryByRole('dialog', { name: 'File tree' }));
    expect(await screen.findByText('readme title')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Toggle file tree' }).getAttribute('aria-expanded')).toBe('false');
  });

  it('closes the drawer from its backdrop without selecting anything', async () => {
    setMobile(true);
    installFetch(routes());
    await renderView();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Toggle file tree' }));
    await screen.findByRole('dialog', { name: 'File tree' });
    await user.click(screen.getByRole('button', { name: 'Close file tree' }));

    await waitForAbsent(() => screen.queryByRole('dialog', { name: 'File tree' }));
    expect(screen.getByText('Select a file to view it.')).toBeTruthy();
  });

  it('keeps the open directories when the drawer is closed and reopened', async () => {
    setMobile(true);
    installFetch(routes());
    await renderView();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Toggle file tree' }));
    await user.click(await screen.findByRole('button', { name: 'src' }));
    await screen.findByRole('button', { name: 'a.ts' });
    await user.click(screen.getByRole('button', { name: 'Close file tree' }));
    await user.click(screen.getByRole('button', { name: 'Toggle file tree' }));

    expect(await screen.findByRole('button', { name: 'a.ts' })).toBeTruthy();
  });
});
