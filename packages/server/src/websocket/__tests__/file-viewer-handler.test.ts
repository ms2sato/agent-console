import { describe, it, expect, mock } from 'bun:test';
import type { WSContext } from 'hono/ws';
import * as v from 'valibot';
import { FileViewerServerMessageSchema } from '@agent-console/shared';
import { createFileViewerHandlers, viewerIgnores } from '../file-viewer-handler.js';
import type { subscribeToFileChanges, FileChangeSubscriber } from '../../services/file-watch-service.js';
import { asWSContext } from './ws-test-helpers.js';

function createMockWs() {
  const sent: string[] = [];
  const closeCalls: unknown[] = [];
  const ws = asWSContext({
    send: (data: string) => {
      sent.push(data);
    },
    close: (...args: unknown[]) => {
      closeCalls.push(args);
    },
    readyState: 1,
  });
  return Object.assign(ws, { sent, closeCalls }) as WSContext & { sent: string[]; closeCalls: unknown[] };
}

function createHarness() {
  const subscribers: FileChangeSubscriber[] = [];
  const unsubscribes: Array<ReturnType<typeof mock>> = [];
  const subscribe = mock(((_path: string, subscriber: FileChangeSubscriber) => {
    subscribers.push(subscriber);
    const unsubscribe = mock(() => {});
    unsubscribes.push(unsubscribe);
    return unsubscribe;
  }) as unknown as typeof subscribeToFileChanges);
  const handlers = createFileViewerHandlers({ subscribe });
  return { handlers, subscribe, subscribers, unsubscribes };
}

const DOTENV_LOCAL = ['.', 'env', '.local'].join('');

describe('createFileViewerHandlers', () => {
  it('subscribes once to the session location with the viewer predicate and the documented timings', () => {
    const { handlers, subscribe, subscribers } = createHarness();
    handlers.handleConnection(createMockWs(), 's1', 'w1', '/work/dir');

    expect(subscribe).toHaveBeenCalledTimes(1);
    expect((subscribe.mock.calls[0] as unknown[])[0]).toBe('/work/dir');
    const subscriber = subscribers[0];
    expect(subscriber.debounceMs).toBe(300);
    expect(subscriber.maxWaitMs).toBe(2000);
    expect(subscriber.maxPaths).toBe(200);
    for (const ignored of ['a/.git/HEAD', '.git/index', 'node_modules/x', 'a/node_modules/b']) {
      expect(subscriber.ignore(ignored)).toBe(true);
    }
    for (const passed of ['.github/ci.yml', '.gitignore', 'error.log', 'catalog.logic.ts', DOTENV_LOCAL, 'foo.git/x', 'dist/x.js']) {
      expect(subscriber.ignore(passed)).toBe(false);
    }
  });

  it('a batch becomes exactly one files-changed frame that parses with the shared schema', () => {
    const { handlers, subscribers } = createHarness();
    const ws = createMockWs();
    handlers.handleConnection(ws, 's1', 'w1', '/work/dir');

    subscribers[0].onChange({ paths: ['sub/a.ts', 'b.ts'], overflow: false });

    expect(ws.sent).toHaveLength(1);
    const parsed = v.parse(FileViewerServerMessageSchema, JSON.parse(ws.sent[0]));
    expect(parsed).toEqual({ type: 'files-changed', paths: ['sub/a.ts', 'b.ts'], overflow: false });
  });

  it('onError sends one watch-unavailable frame, keeps the socket open and sends nothing more', () => {
    const { handlers, subscribers } = createHarness();
    const ws = createMockWs();
    handlers.handleConnection(ws, 's1', 'w1', '/work/dir');

    subscribers[0].onError('permission-denied');

    expect(ws.sent.map((m) => v.parse(FileViewerServerMessageSchema, JSON.parse(m)))).toEqual([
      { type: 'watch-unavailable', reason: 'permission-denied' },
    ]);
    expect(ws.closeCalls).toEqual([]);
  });

  it('disconnection unsubscribes once; a second disconnection is a no-op', () => {
    const { handlers, unsubscribes } = createHarness();
    handlers.handleConnection(createMockWs(), 's1', 'w1', '/work/dir');

    handlers.handleDisconnection('s1', 'w1');
    handlers.handleDisconnection('s1', 'w1');

    expect(unsubscribes[0]).toHaveBeenCalledTimes(1);
  });

  it('a late close of the OLD socket after a reconnect does not unsubscribe the NEW socket\'s watch', () => {
    const { handlers, unsubscribes } = createHarness();
    const ws1 = createMockWs();
    const ws2 = createMockWs();
    handlers.handleConnection(ws1, 's1', 'w1', '/work/dir');
    handlers.handleConnection(ws2, 's1', 'w1', '/work/dir');
    expect(unsubscribes[0]).toHaveBeenCalledTimes(1); // the reconnect replaced the first subscription

    handlers.handleDisconnection('s1', 'w1', ws1);
    expect(unsubscribes[1]).not.toHaveBeenCalled();

    handlers.handleDisconnection('s1', 'w1', ws2);
    expect(unsubscribes[1]).toHaveBeenCalledTimes(1);
  });

  it('a disconnection without a socket (service teardown) unsubscribes whichever socket is current', () => {
    const { handlers, unsubscribes } = createHarness();
    handlers.handleConnection(createMockWs(), 's1', 'w1', '/work/dir');

    handlers.handleDisconnection('s1', 'w1');

    expect(unsubscribes[0]).toHaveBeenCalledTimes(1);
  });

  it('a reconnect of the same worker replaces the earlier subscription', () => {
    const { handlers, unsubscribes } = createHarness();
    handlers.handleConnection(createMockWs(), 's1', 'w1', '/work/dir');
    handlers.handleConnection(createMockWs(), 's1', 'w1', '/work/dir');

    expect(unsubscribes[0]).toHaveBeenCalledTimes(1);
    expect(unsubscribes[1]).not.toHaveBeenCalled();
  });

  it('two viewer workers on one path keep separate subscriptions (keyed by worker, not by path)', () => {
    const { handlers, unsubscribes } = createHarness();
    handlers.handleConnection(createMockWs(), 's1', 'w1', '/work/dir');
    handlers.handleConnection(createMockWs(), 's1', 'w2', '/work/dir');

    handlers.handleDisconnection('s1', 'w1');

    expect(unsubscribes[0]).toHaveBeenCalledTimes(1);
    expect(unsubscribes[1]).not.toHaveBeenCalled();
  });

  it('handleMessage answers with an UNSUPPORTED_OPERATION error frame and does not close', () => {
    const { handlers } = createHarness();
    const ws = createMockWs();

    handlers.handleMessage(ws);

    expect(ws.sent.map((m) => JSON.parse(m))).toEqual([
      { type: 'error', message: 'The file viewer accepts no client messages', code: 'UNSUPPORTED_OPERATION' },
    ]);
    expect(ws.closeCalls).toEqual([]);
  });

  it('a send on a socket that already closed does not throw', () => {
    const { handlers, subscribers } = createHarness();
    const ws = asWSContext({
      send: () => {
        throw new Error('closed');
      },
      close: () => {},
      readyState: 3,
    });
    handlers.handleConnection(ws, 's1', 'w1', '/work/dir');

    expect(() => subscribers[0].onChange({ paths: ['a'], overflow: false })).not.toThrow();
  });
});

describe('viewerIgnores', () => {
  it('compares whole segments with equality', () => {
    expect(viewerIgnores('')).toBe(false);
    expect(viewerIgnores('node_modules')).toBe(true);
    expect(viewerIgnores('node_modules_backup/x')).toBe(false);
    expect(viewerIgnores('.github/x')).toBe(false);
  });
});
