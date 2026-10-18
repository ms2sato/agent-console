// NOTE: The socket is a MockWebSocket and the frames are real JSON strings, so
// each batch goes through worker-websocket.ts's strict schema parse. The
// server-populates -> serialise -> parse round trip lives in
// packages/integration/src/.
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useFileViewerLiveUpdates } from '../useFileViewerLiveUpdates';
import { fileViewerKeys } from '../../FileViewerTree';
import { MockWebSocket, installMockWebSocket } from '../../../../test/mock-websocket';
import { _reset } from '../../../../lib/worker-websocket';

const S = 's1';
const W = 'w1';

describe('useFileViewerLiveUpdates', () => {
  let restoreWebSocket: () => void;
  let queryClient: QueryClient;
  let invalidated: Array<{ queryKey: readonly unknown[]; exact?: boolean; refetchType?: string }>;

  beforeEach(() => {
    restoreWebSocket = installMockWebSocket();
    _reset();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    invalidated = [];
    spyOn(queryClient, 'invalidateQueries').mockImplementation(((filters: (typeof invalidated)[number]) => {
      invalidated.push(filters);
      return Promise.resolve();
    }) as typeof queryClient.invalidateQueries);
  });

  afterEach(() => {
    _reset();
    restoreWebSocket();
  });

  function setup(selectedPath: string | null = null) {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const hook = renderHook((props: { selectedPath: string | null }) =>
      useFileViewerLiveUpdates({ sessionId: S, workerId: W, selectedPath: props.selectedPath }), {
      wrapper,
      initialProps: { selectedPath },
    });
    const ws = MockWebSocket.getLastInstance()!;
    act(() => ws.simulateOpen());
    return { ...hook, ws };
  }

  function send(ws: MockWebSocket, paths: string[], overflow = false) {
    act(() => ws.simulateMessage(JSON.stringify({ type: 'files-changed', paths, overflow })));
  }

  const tree = (dir: string) => ({ queryKey: fileViewerKeys.tree(S, W, dir), exact: true });
  const content = (path: string) => ({ queryKey: fileViewerKeys.content(S, W, path), exact: true });

  it('connects a file-viewer socket for the worker on mount and disconnects on unmount', () => {
    const { ws, unmount } = setup();
    expect(ws.url).toContain(S);
    expect(ws.url).toContain(W);

    unmount();

    expect(ws.close).toHaveBeenCalled();
  });

  const cases: Array<{
    name: string;
    paths: string[];
    selected: string | null;
    expected: Array<ReturnType<typeof tree> | ReturnType<typeof content>>;
  }> = [
    { name: 'a nested file invalidates its directory', paths: ['sub/a.ts'], selected: null, expected: [tree('sub')] },
    { name: 'a root-level file invalidates the root listing', paths: ['a.ts'], selected: null, expected: [tree('')] },
    {
      name: 'two files in one directory invalidate it once',
      paths: ['sub/a.ts', 'sub/b.ts'],
      selected: null,
      expected: [tree('sub')],
    },
    {
      name: 'files in two directories invalidate each once',
      paths: ['sub/a.ts', 'other/b.ts', 'sub/c.ts'],
      selected: null,
      expected: [tree('sub'), tree('other')],
    },
    {
      name: 'the selected file also invalidates its content',
      paths: ['sub/a.ts'],
      selected: 'sub/a.ts',
      expected: [tree('sub'), content('sub/a.ts')],
    },
    {
      name: 'another selected file invalidates the directory only',
      paths: ['sub/a.ts'],
      selected: 'other.ts',
      expected: [tree('sub')],
    },
    { name: 'an empty batch invalidates nothing', paths: [], selected: 'a.ts', expected: [] },
  ];

  it.each(cases)('$name', ({ paths, selected, expected }) => {
    const { ws } = setup(selected);

    send(ws, paths);

    expect(invalidated).toEqual(expected);
  });

  it('invalidates the worker prefix once on overflow, and nothing per path', () => {
    const { ws } = setup('sub/a.ts');

    send(ws, ['sub/a.ts', 'x/y.ts'], true);

    expect(invalidated).toEqual([{ queryKey: fileViewerKeys.worker(S, W) }]);
  });

  it('never asks to refetch inactive queries', () => {
    const { ws } = setup('sub/a.ts');

    send(ws, ['sub/a.ts']);

    expect(invalidated.every((f) => f.refetchType === undefined)).toBe(true);
  });

  it('reads the latest selection without reconnecting', () => {
    const { ws, rerender } = setup(null);
    const instancesBefore = MockWebSocket.getInstances().length;

    rerender({ selectedPath: 'sub/a.ts' });
    send(ws, ['sub/a.ts']);

    expect(MockWebSocket.getInstances().length).toBe(instancesBefore);
    expect(invalidated).toEqual([tree('sub'), content('sub/a.ts')]);
  });

  it('does not invalidate the worker prefix on the first open', () => {
    setup();
    expect(invalidated).toEqual([]);
  });

  it('invalidates the worker prefix once when the socket reopens after an abnormal close', () => {
    const randomSpy = spyOn(Math, 'random').mockReturnValue(0.5);
    const timeoutSpy = spyOn(globalThis, 'setTimeout');
    try {
      const { ws } = setup();

      act(() => ws.simulateClose(1006));
      const reconnectCall = timeoutSpy.mock.calls.find((c: unknown[]) => c[1] === 1000);
      expect(reconnectCall).toBeDefined();
      act(() => (reconnectCall![0] as () => void)());
      expect(invalidated).toEqual([]); // not before the new socket opens

      act(() => MockWebSocket.getLastInstance()!.simulateOpen());

      expect(invalidated).toEqual([{ queryKey: fileViewerKeys.worker(S, W) }]);
    } finally {
      timeoutSpy.mockRestore();
      randomSpy.mockRestore();
    }
  });

  it('reports watch-unavailable with its reason and keeps the connection', () => {
    const { ws, result } = setup();
    expect(result.current.watchUnavailable).toBeNull();

    act(() => ws.simulateMessage(JSON.stringify({ type: 'watch-unavailable', reason: 'permission-denied' })));

    expect(result.current.watchUnavailable).toBe('permission-denied');
    expect(ws.close).not.toHaveBeenCalled();
  });

  it('ignores a frame that fails the strict schema', () => {
    const { ws, result } = setup();

    act(() => ws.simulateMessage(JSON.stringify({ type: 'files-changed', paths: ['a.ts'], overflow: false, extra: 1 })));
    act(() => ws.simulateMessage(JSON.stringify({ type: 'watch-unavailable', reason: 'nope' })));

    expect(invalidated).toEqual([]);
    expect(result.current.watchUnavailable).toBeNull();
  });
});
