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

const originalFetch = globalThis.fetch;
const originalMatchMedia = window.matchMedia;

afterAll(() => {
  globalThis.fetch = originalFetch;
});
beforeEach(() => {
  window.matchMedia = originalMatchMedia;
});
afterEach(() => {
  cleanup();
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

        expect(screen.queryByRole('button', { name: 'guide.md' })).toBeNull();
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
        expect(screen.queryByText('linked content')).toBeNull();
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
