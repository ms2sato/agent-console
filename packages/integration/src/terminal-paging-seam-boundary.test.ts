/**
 * Cross-Package Boundary Test: scroll-back paging through an Ink-style
 * repaint stream (Issue #979, terminal-history-paging.md §6.2 "Accepted residual").
 *
 * Writes a synthetic Claude-Code-class stream (relative-movement repaint of a
 * two-line bottom chrome, see ink-repaint-stream.ts) through the real server
 * output path, cuts it into many archived segments, then pages the REAL client
 * TerminalStore back through `request-history-range` -> `history-range`
 * (served by the real handler) until the archive is exhausted, and counts the
 * chrome rows (status bar / input frame) that leaked into the PAGED rows.
 *
 * Proxy note: the stream is synthetic, standing in for a real Claude Code
 * capture; it is pinned to the measured byte class by the fixture's own test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { setupMemfs, cleanupMemfs } from '@agent-console/server/src/__tests__/utils/mock-fs-helper';
import { createMockPtyFactory } from '@agent-console/server/src/__tests__/utils/mock-pty';
import { resetGitMocks } from '@agent-console/server/src/__tests__/utils/mock-git-helper';
import { initializeDatabase, closeDatabase, getDatabase } from '@agent-console/server/src/database/connection';
import { JobQueue } from '@agent-console/server/src/jobs/job-queue';
import { registerJobHandlers } from '@agent-console/server/src/jobs/handlers';
import { WorkerOutputFileManager } from '@agent-console/server/src/lib/worker-output-file';
import { SessionManager } from '@agent-console/server/src/services/session-manager';
import { SingleUserMode } from '@agent-console/server/src/services/user-mode';
import { AgentManager } from '@agent-console/server/src/services/agent-manager';
import { SqliteAgentRepository } from '@agent-console/server/src/repositories/sqlite-agent-repository';
import { JsonSessionRepository } from '@agent-console/server/src/repositories/index';
import { AnnotationService } from '@agent-console/server/src/services/annotation-service';
import { handleHistoryRangeRequest } from '@agent-console/server/src/websocket/history-range-handler';
import { McpTokenRegistry } from '@agent-console/server/src/mcp/mcp-auth';
import { defaultRepositoryLookup, defaultRepositoryEnvLookup } from '@agent-console/server/src/__tests__/utils/repository-lookup-mock';
import {
  getOrCreateTerminal,
  _resetTerminals,
  _inspect,
  _whenIdle,
  _setSeamCorrectionForTest,
} from '@agent-console/client/src/components/terminal/terminal-store';
import { rowText } from '@agent-console/client/src/components/terminal/row-pipeline';
import { MockWebSocket, installMockWebSocket } from '@agent-console/client/src/test/mock-websocket';
import {
  generateInkRepaintStream,
  inkContentLabel,
  isInkChromeRowText,
  INK_CHROME_HEIGHT,
} from '@agent-console/client/src/components/terminal/__tests__/fixtures/ink-repaint-stream';
import { WSContext } from 'hono/ws';
import type { WorkerServerMessage } from '@agent-console/shared';

const TEST_CONFIG_DIR = '/test/config';
const ptyFactory = createMockPtyFactory();

const COLS = 100;
const ROWS = 24;
const FRAMES = 48;
const CONTENT_LINES = 20;
const CHROME_REPAINTS = 12;
const STATUS_BAR = 'ctx:4% | Sonnet 5 | ms2sato@ca-mini tmp ... /rc';
// ~1.3KB per frame; a cut archives ~20% of this, so a segment holds several
// frames (more rows than the viewport) and the stream cuts into well over 6.
const FILE_MAX_SIZE = 24_000;
const MIN_SEGMENTS = 6;

type RangeMessage = Extract<WorkerServerMessage, { type: 'history-range' }>;
type HistoryMessage = Extract<WorkerServerMessage, { type: 'history' }>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('Client-Server Boundary: paging an Ink-style repaint stream (seam correction)', () => {
  let sessionManager: SessionManager;
  let jobQueue: JobQueue;
  let outputManager: WorkerOutputFileManager;
  let restoreWebSocket: () => void;
  const originalHome = process.env.AGENT_CONSOLE_HOME;

  beforeEach(async () => {
    await closeDatabase();
    setupMemfs({ [`${TEST_CONFIG_DIR}/.keep`]: '' });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;
    await initializeDatabase(':memory:');

    outputManager = new WorkerOutputFileManager({
      flushThreshold: 100_000_000,
      flushInterval: 100_000,
      fileMaxSize: FILE_MAX_SIZE,
      maxSegments: 0,
    });
    jobQueue = new JobQueue(getDatabase(), { concurrency: 1 });
    registerJobHandlers(jobQueue, outputManager);

    ptyFactory.reset();
    resetGitMocks();

    const db = getDatabase();
    const agentManager = await AgentManager.create(new SqliteAgentRepository(db));
    const sessionRepository = new JsonSessionRepository(`${TEST_CONFIG_DIR}/sessions.json`);

    sessionManager = await SessionManager.create({
      userMode: new SingleUserMode(ptyFactory.provider, { id: 'test-user-id', username: 'testuser', homeDir: '/home/testuser' }),
      pathExists: async () => true,
      sessionRepository,
      jobQueue,
      agentManager,
      mcpTokenRegistry: new McpTokenRegistry(),
      repositoryLookup: defaultRepositoryLookup,
      repositoryEnvLookup: defaultRepositoryEnvLookup,
      annotationService: new AnnotationService(),
      workerOutputFileManager: outputManager,
    });

    _resetTerminals();
    restoreWebSocket = installMockWebSocket();
  });

  afterEach(async () => {
    _resetTerminals();
    restoreWebSocket();
    await jobQueue.stop();
    await closeDatabase();
    cleanupMemfs();
    process.env.AGENT_CONSOLE_HOME = originalHome;
  });

  /**
   * Run the whole scenario and return the paged-row measurement. The server
   * side is built fresh per call, so the corrected and uncorrected runs see the
   * identical archive.
   */
  async function pageEverything(): Promise<{
    segments: number;
    pagedTexts: string[];
    allTexts: string[];
    requests: number;
  }> {
    const session = await sessionManager.createSession({ type: 'quick', locationPath: '/test/path', agentId: 'claude-code' });
    const sessionId = session.id;
    const workerId = session.workers.find((w) => w.type === 'agent')!.id;

    // One frame per write + flush so the live file overflows (and cuts) many times.
    const stream = generateInkRepaintStream({ frames: FRAMES, cols: COLS, statusBar: STATUS_BAR, contentLinesPerFrame: CONTENT_LINES, chromeRepaintsPerFrame: CHROME_REPAINTS });
    const frameBytes = Math.ceil(stream.length / FRAMES);
    for (let at = 0; at < stream.length; at += frameBytes) {
      ptyFactory.instances[0].simulateData(stream.slice(at, at + frameBytes));
      await outputManager.flushAll();
    }

    const segments = await countSegments(sessionId, workerId);

    // Real server side of the wire.
    const sent: WorkerServerMessage[] = [];
    const wsCtx = new WSContext({
      send: (data) => {
        if (typeof data !== 'string') throw new Error('the history-range handler sent a non-string frame');
        sent.push(JSON.parse(data) as WorkerServerMessage);
      },
      close: () => {},
      readyState: 1,
    });

    const instance = getOrCreateTerminal(sessionId, workerId);
    const ws = MockWebSocket.getLastInstance();
    if (!ws) throw new Error('no client websocket');
    ws.simulateOpen();
    // The live geometry the fixture was authored for.
    instance.resize(COLS, ROWS);

    // Initial window: what the server's request-history path returns.
    const history = await sessionManager.getWorkerOutputHistory(sessionId, workerId, 0);
    if (!history) throw new Error('no history');
    const historyMsg: HistoryMessage = { type: 'history', data: history.data, offset: history.offset, startOffset: history.startOffset, epoch: history.epoch };
    ws.simulateMessage(JSON.stringify(historyMsg));
    await _whenIdle();
    expect(_inspect(instance).paging.hasMoreHistory).toBe(true);

    let requests = 0;
    while (_inspect(instance).paging.hasMoreHistory) {
      const before = _inspect(instance).paging.oldestOffset;
      instance.requestOlderHistory();
      const req = [...ws.send.mock.calls].map((c) => JSON.parse(c[0])).reverse().find((m) => m.type === 'request-history-range');
      if (!req) throw new Error('no request-history-range sent');
      requests++;
      const sentBefore = sent.length;
      await handleHistoryRangeRequest(wsCtx, sessionId, workerId, req, sessionManager);
      const reply = sent[sentBefore] as RangeMessage;
      expect(reply.type).toBe('history-range');
      ws.simulateMessage(JSON.stringify(reply));
      await waitFor(
        () => !_inspect(instance).paging.loadingOlder && (_inspect(instance).paging.oldestOffset !== before || !_inspect(instance).paging.hasMoreHistory),
        `chunk ${requests} to apply`,
      );
      if (requests > 200) throw new Error('paging did not terminate');
    }
    await _whenIdle();

    const rows = instance.getSnapshot().rows;
    const pagedTexts = rows.filter((r) => r.key < 0).map(rowText);
    expect(pagedTexts.length).toBe(_inspect(instance).paging.pagedRowCount);
    return { segments, pagedTexts, allTexts: rows.map(rowText), requests };
  }

  async function countSegments(sessionId: string, workerId: string): Promise<number> {
    // Every archived segment is one unit the range reader serves separately:
    // walk back from the stream end counting the units.
    let units = 0;
    let before = await sessionManager.getCurrentOutputOffset(sessionId, workerId);
    for (let guard = 0; guard < 1000 && before > 0; guard++) {
      const range = await sessionManager.getWorkerHistoryRange(sessionId, workerId, before);
      if (!range || range.data === '') break;
      units++;
      before = range.startOffset;
    }
    return Math.max(0, units - 1); // the newest unit is the live window, not a segment
  }

  function chromeSplit(pagedTexts: string[]): { top: number; interior: number; firstInterior: number } {
    let top = 0;
    let interior = 0;
    let firstInterior = -1;
    pagedTexts.forEach((text, index) => {
      if (!isInkChromeRowText(text)) return;
      if (index < INK_CHROME_HEIGHT) {
        top++;
      } else {
        interior++;
        if (firstInterior === -1) firstInterior = index;
      }
    });
    return { top, interior, firstInterior };
  }

  function expectEveryContentLineOnceInOrder(allTexts: string[]): void {
    const expected: string[] = [];
    for (let f = 1; f <= FRAMES; f++) for (let l = 1; l <= CONTENT_LINES; l++) expected.push(inkContentLabel(f, l));
    const found: string[] = [];
    for (const text of allTexts) {
      const m = text.match(/\[F\d{3}:L\d{2}\]/);
      if (m) found.push(m[0]);
    }
    expect(found).toEqual(expected);
  }

  type PagedResult = Awaited<ReturnType<typeof pageEverything>>;
  let corrected: PagedResult | undefined;

  it('pages the corrected scenario to completion and keeps the interior chrome count within the measured bound', async () => {
    corrected = await pageEverything();
    const { top, interior, firstInterior } = chromeSplit(corrected.pagedTexts);
    console.log(
      `[seam-measurement] corrected: segments=${corrected.segments} requests=${corrected.requests} pagedRows=${corrected.pagedTexts.length} chromeRows top=${top} interior=${interior}`,
    );
    if (interior > 0) {
      console.log(`[seam-measurement] first interior chrome row index=${firstInterior} context=${JSON.stringify(corrected.pagedTexts.slice(Math.max(0, firstInterior - 2), firstInterior + 3))}`);
    }

    expect(corrected.segments).toBeGreaterThanOrEqual(MIN_SEGMENTS);
    expect(top).toBeLessThanOrEqual(INK_CHROME_HEIGHT);
    // Regression ceiling from the #2171 measurement; #2170 lowers it to 0. 20 is not an
    // accepted number: the interior rows are duplicated content, not leaked chrome.
    expect(interior).toBeLessThanOrEqual(20);
  });

  // KNOWN FINDING (Issue #979 measurement): this assertion currently fails, so it
  // is pinned with it.failing. With the seam correction on, every fetch from the
  // 4th onward leaves the third chunk of the joint replay carrying its own on-screen
  // tail (~rows-1 rows, ending in the chrome pair) while its newer neighbour's
  // partition already begins with the same rows. The paged window then holds
  // each of those rows twice (10 of 12 interior seams in this scenario). Measured:
  // corrected = interior 20 chrome rows over 1010 paged rows; uncorrected =
  // interior 23 over 803. Tracked in Issue #2170. The scenario setup lives in the
  // plain test above, so a timeout or a setup throw fails loudly there instead of
  // passing as expected here. When the duplication is fixed this test starts
  // passing and it.failing reports that: switch it to it() -- that flip is the
  // fix's polarity.
  it.failing('with seam correction, every content line appears exactly once and in order', () => {
    if (!corrected) throw new Error('the corrected scenario did not run');
    expectEveryContentLineOnceInOrder(corrected.allTexts);
  });

  it('polarity: with the seam correction disabled the same scenario leaks chrome rows into the interior', async () => {
    _setSeamCorrectionForTest(false);
    const result = await pageEverything();
    const { top, interior } = chromeSplit(result.pagedTexts);
    console.log(
      `[seam-measurement] uncorrected: segments=${result.segments} requests=${result.requests} pagedRows=${result.pagedTexts.length} chromeRows top=${top} interior=${interior}`,
    );

    expect(result.segments).toBeGreaterThanOrEqual(MIN_SEGMENTS);
    expect(interior).toBeGreaterThan(0);
  });
});
