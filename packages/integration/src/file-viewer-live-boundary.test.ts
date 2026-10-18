/**
 * Client-Server Boundary Test: the file viewer worker's live-update frames
 * (CLAUDE.md pre-PR Q10)
 *
 * The viewer's worker WebSocket carries two server-to-client messages. Server
 * unit tests assert the handler against a stand-in `subscribe`; shared tests
 * assert the schema against hand-written values. Neither proves that what the
 * REAL handler and the REAL watcher batch builder emit survives the schema the
 * client parses with (strict: an extra or mistyped field drops the whole frame).
 *
 * Real: `createFileViewerHandlers`, `subscribeToFileChanges` (debounce, max
 * wait, distinct-path cap, overflow), the JSON, `FileViewerServerMessageSchema`.
 * Recorded proxy (pre-pr-completeness Q13): `fs.watch` is an injected fake,
 * because the in-memory filesystem every test fixture shares does not model
 * recursive watch events. The real watcher is measured against a real directory
 * in packages/server's file-watch-service-real-fs.test.ts.
 *
 * NOTE: packages/integration uses a FLAT sibling test layout (no __tests__/).
 */
import { describe, it, expect } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { watch as fsWatch } from 'node:fs';
import * as v from 'valibot';

import { createFileViewerHandlers } from '@agent-console/server/src/websocket/file-viewer-handler';
import { subscribeToFileChanges } from '@agent-console/server/src/services/file-watch-service';
import { FileViewerServerMessageSchema } from '@agent-console/shared';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function createFakeWatch() {
  let listener: ((eventType: string, filename: string | null) => void) | null = null;
  const watcher = Object.assign(new EventEmitter(), { close: () => {} });
  const watch = ((_path: string, _options: unknown, cb: typeof listener) => {
    listener = cb;
    return watcher;
  }) as unknown as typeof fsWatch;
  return { watch, emit: (filename: string) => listener?.('change', filename) };
}

function createWs() {
  const sent: string[] = [];
  const ws = { send: (data: string) => sent.push(data), close: () => {}, readyState: 1 };
  return { ws: ws as unknown as Parameters<ReturnType<typeof createFileViewerHandlers>['handleConnection']>[0], sent };
}

// Distinct directory per test: the watcher is keyed by path.
let counter = 0;

describe('Client-Server Boundary: file viewer live updates', () => {
  it('two events become ONE files-changed frame that the client schema parses', async () => {
    const fake = createFakeWatch();
    const handlers = createFileViewerHandlers({ subscribe: (p, s) => subscribeToFileChanges(p, s, { watch: fake.watch }) });
    const { ws, sent } = createWs();
    handlers.handleConnection(ws, 'session', 'worker', `/virtual/live-${counter++}`);

    fake.emit('sub/a.ts');
    fake.emit('b.ts');
    fake.emit('node_modules/ignored.js');
    await sleep(500); // the viewer's 300 ms debounce

    expect(sent).toHaveLength(1);
    expect(v.parse(FileViewerServerMessageSchema, JSON.parse(sent[0]))).toEqual({
      type: 'files-changed',
      paths: ['sub/a.ts', 'b.ts'],
      overflow: false,
    });
    handlers.handleDisconnection('session', 'worker');
  });

  it('a burst of 201 distinct paths parses with overflow and exactly 200 paths', async () => {
    const fake = createFakeWatch();
    const handlers = createFileViewerHandlers({ subscribe: (p, s) => subscribeToFileChanges(p, s, { watch: fake.watch }) });
    const { ws, sent } = createWs();
    handlers.handleConnection(ws, 'session', 'worker', `/virtual/live-${counter++}`);

    for (let i = 0; i < 201; i++) fake.emit(`d/f${i}.ts`);
    await sleep(500);

    expect(sent).toHaveLength(1);
    const parsed = v.parse(FileViewerServerMessageSchema, JSON.parse(sent[0]));
    expect(parsed.type).toBe('files-changed');
    if (parsed.type !== 'files-changed') throw new Error('unreachable');
    expect(parsed.overflow).toBe(true);
    expect(parsed.paths).toHaveLength(200);
    handlers.handleDisconnection('session', 'worker');
  });
});
