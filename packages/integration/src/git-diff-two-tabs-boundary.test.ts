/**
 * Two browser tabs on one git-diff worker (CLAUDE.md pre-PR Q10, shipping path)
 *
 * The git-diff handler used to key its connection by worker, so a second tab
 * replaced the first tab's file watch and a late close could stop the live
 * one. This drives the REAL handler, the REAL `startWatching` (the diff
 * worker's subscriber of the shared watcher, its debounce and ignore rule) and
 * the REAL shared watcher with two mock sockets: one change event must reach
 * both, and closing one must leave the other live.
 *
 * Recorded proxies (pre-pr-completeness Q13): `fs.watch` is an injected fake
 * held open by a first subscriber (the in-memory filesystem every test fixture
 * shares does not model watch events; the real watcher is measured in
 * packages/server's file-watch-service-real-fs.test.ts), and `getDiffData` /
 * the ref resolvers return fixed values (git is not under test here).
 *
 * NOTE: packages/integration uses a FLAT sibling test layout (no __tests__/).
 */
import { describe, it, expect } from 'bun:test';
import { createGitDiffHandlers } from '@agent-console/server/src/websocket/git-diff-handler';
import { startWatching } from '@agent-console/server/src/services/git-diff-service';
import { subscribeToFileChanges } from '@agent-console/server/src/services/file-watch-service';
import { AnnotationService } from '@agent-console/server/src/services/annotation-service';
import { asWSContext } from '@agent-console/server/src/websocket/__tests__/ws-test-helpers';
import { createFakeWatch } from '@agent-console/server/src/__tests__/utils/fake-file-watch';
import type { GitDiffData, GitDiffServerMessage } from '@agent-console/shared';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const diffData: GitDiffData = {
  summary: {
    baseCommit: 'abc123',
    targetRef: 'working-dir',
    files: [],
    totalAdditions: 0,
    totalDeletions: 0,
    updatedAt: '2026-10-19T00:00:00.000Z',
  },
  rawDiff: '',
};

function createWs() {
  const sent: string[] = [];
  const ws = asWSContext({ send: (data: string) => void sent.push(data), close: () => {}, readyState: 1 });
  return { ws, sent };
}

const kinds = (sent: string[]) => sent.map((m) => (JSON.parse(m) as GitDiffServerMessage).type);

describe('Client-Server Boundary: two tabs on one git-diff worker', () => {
  it('one change reaches both sockets, and closing one leaves the other live', async () => {
    const path = '/virtual/two-tabs-diff';
    const fake = createFakeWatch();
    // A first subscriber holds the shared watch open through the fake `watch`; the diff subscriptions join it.
    const holder = subscribeToFileChanges(
      path,
      { ignore: () => true, debounceMs: 20, maxWaitMs: null, maxPaths: 1, onChange: () => {}, onError: () => {} },
      { watch: fake.watch },
    );
    const handlers = createGitDiffHandlers({
      getDiffData: async () => diffData,
      resolveRef: async (ref) => ref,
      resolveBaseSpec: async (spec) => spec,
      startWatching,
      getFileLines: async () => [],
      annotationService: new AnnotationService(),
    });
    const tab1 = createWs();
    const tab2 = createWs();
    await handlers.handleConnection(tab1.ws, 'session', 'worker', path, 'base', null);
    await handlers.handleConnection(tab2.ws, 'session', 'worker', path, 'base', null);
    expect(kinds(tab1.sent)).toEqual(['diff-data']);
    expect(kinds(tab2.sent)).toEqual(['diff-data']);

    fake.emit('src/a.ts');
    await sleep(500); // the diff worker's 300 ms debounce
    expect(kinds(tab1.sent)).toEqual(['diff-data', 'diff-data']);
    expect(kinds(tab2.sent)).toEqual(['diff-data', 'diff-data']);

    await handlers.handleDisconnection('session', 'worker', tab1.ws);
    fake.emit('src/b.ts');
    await sleep(500);

    expect(kinds(tab1.sent)).toEqual(['diff-data', 'diff-data']);
    expect(kinds(tab2.sent)).toEqual(['diff-data', 'diff-data', 'diff-data']);

    await handlers.handleDisconnection('session', 'worker', tab2.ws);
    holder();
    expect(fake.closeCount()).toBe(1);
  });
});
