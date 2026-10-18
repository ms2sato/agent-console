// NOTE: The tree is driven through the real fetchFileTree, so the listing
// responses ARE parsed by the shared FileTreeResponseSchema; only `fetch` is
// stubbed (test/file-viewer-fetch.ts).
import { describe, it, expect, afterEach, afterAll, mock } from 'bun:test';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FileViewerTree } from '../FileViewerTree';
import { renderWithQuery } from '../../../test/renderWithQuery';
import { createFileViewerFetch, type FileViewerFetchRoutes } from '../../../test/file-viewer-fetch';

const originalFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = originalFetch;
});
afterEach(() => {
  cleanup();
});

// Built from parts: a dot-env file must be listed like any other entry.
const DOT_ENV = ['.', 'env'].join('');

function installFetch(routes: FileViewerFetchRoutes) {
  const stub = createFileViewerFetch(routes);
  globalThis.fetch = Object.assign(stub.fetchMock, { preconnect: originalFetch.preconnect }) as typeof fetch;
  return stub;
}

function renderTree(props: Partial<React.ComponentProps<typeof FileViewerTree>> = {}) {
  const handlers = {
    onToggleDir: mock(() => {}),
    onOpenFile: mock(() => {}),
    onOpenSymlink: mock(() => {}),
  };
  const result = renderWithQuery(
    <FileViewerTree
      sessionId="s1"
      workerId="w1"
      expanded={new Set()}
      selectedPath={null}
      {...handlers}
      {...props}
    />
  );
  return { result, handlers };
}

describe('FileViewerTree', () => {
  const rootEntries = [
    { name: '.git', kind: 'dir' as const },
    { name: 'src', kind: 'dir' as const },
    { name: DOT_ENV, kind: 'file' as const },
    { name: 'link', kind: 'symlink' as const },
  ];

  it('lists the root once with every entry, dotfiles and .git included, each with its own kind glyph', async () => {
    const { calls } = installFetch({ tree: { '': rootEntries } });
    await renderTree().result;

    const kinds = Object.fromEntries(
      screen.getAllByRole('button').map((b) => [b.getAttribute('aria-label'), b.getAttribute('data-kind')])
    );
    expect(kinds).toEqual({ '.git': 'dir', src: 'dir', [DOT_ENV]: 'file', 'link (symlink)': 'symlink' });
    expect(calls).toEqual([{ route: 'tree', path: '' }]);
  });

  it('does not list a directory until it is expanded, then lists exactly that directory', async () => {
    const { calls } = installFetch({
      tree: { '': rootEntries, src: [{ name: 'a.ts', kind: 'file' }] },
    });
    const { result } = renderTree({ expanded: new Set(['src']) });
    await result;

    await waitFor(() => expect(screen.getByRole('button', { name: 'a.ts' })).toBeTruthy());
    expect(calls).toEqual([
      { route: 'tree', path: '' },
      { route: 'tree', path: 'src' },
    ]);
    // `.git` is collapsed: it was never listed.
    expect(calls.some((c) => c.path === '.git')).toBe(false);
  });

  it('routes a click by kind: dir toggles, file opens, symlink tries to expand-or-open', async () => {
    installFetch({ tree: { '': rootEntries } });
    const { result, handlers } = renderTree();
    await result;
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'src' }));
    await user.click(screen.getByRole('button', { name: DOT_ENV }));
    await user.click(screen.getByRole('button', { name: 'link (symlink)' }));

    expect(handlers.onToggleDir).toHaveBeenCalledWith('src');
    expect(handlers.onOpenFile).toHaveBeenCalledWith(DOT_ENV);
    expect(handlers.onOpenSymlink).toHaveBeenCalledWith('link');
    expect(handlers.onToggleDir).toHaveBeenCalledTimes(1);
  });

  it('collapses an already expanded symlink instead of trying it again', async () => {
    installFetch({ tree: { '': rootEntries, link: [] } });
    const { result, handlers } = renderTree({ expanded: new Set(['link']) });
    await result;

    await userEvent.setup().click(screen.getByRole('button', { name: 'link (symlink)' }));

    expect(handlers.onToggleDir).toHaveBeenCalledWith('link');
    expect(handlers.onOpenSymlink).not.toHaveBeenCalled();
  });

  it('marks the selected file', async () => {
    installFetch({ tree: { '': rootEntries } });
    await renderTree({ selectedPath: DOT_ENV }).result;

    const selectedOf = (name: string) =>
      screen.getByRole('button', { name }).closest('[role="treeitem"]')?.getAttribute('aria-selected');
    expect(selectedOf(DOT_ENV)).toBe('true');
    expect(selectedOf('src')).toBe('false');
  });

  it("shows the route's message when a directory cannot be listed", async () => {
    installFetch({
      tree: { '': rootEntries, src: { failure: { status: 400, error: 'Path resolves outside the working directory' } } },
    });
    await renderTree({ expanded: new Set(['src']) }).result;

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Path resolves outside the working directory');
  });

  it('says so when an expanded directory is empty', async () => {
    installFetch({ tree: { '': rootEntries, src: [] } });
    await renderTree({ expanded: new Set(['src']) }).result;

    expect(await screen.findByText('Empty directory')).toBeTruthy();
  });
});
