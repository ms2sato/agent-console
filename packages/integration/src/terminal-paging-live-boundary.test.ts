/**
 * Cross-Package Boundary Test: the paged rows meet the live window (Issue #2176).
 *
 * Same server/client wiring as terminal-paging-seam-boundary.test.ts, but the
 * measurement spans the CONCATENATION of the paged rows (key < 0) and the live
 * rows (key >= 0): after a real attach (the server's initial `history` window,
 * which starts mid-stream) is rendered into the REAL live TerminalController and
 * the history is paged back to the top, a content label must appear once.
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
import { serverConfig } from '@agent-console/server/src/lib/server-config';
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
  _setLiveEdgePieceBytesForTest,
  getOrCreateTerminal,
  _resetTerminals,
  _inspect,
  _whenIdle,
} from '@agent-console/client/src/components/terminal/terminal-store';
import { replayHistoryJoint } from '@agent-console/client/src/components/terminal/history-replay';
import { rowText } from '@agent-console/client/src/components/terminal/row-pipeline';
import { MockWebSocket, installMockWebSocket } from '@agent-console/client/src/test/mock-websocket';
import {
  generateInkRepaintStream,
} from '@agent-console/client/src/components/terminal/__tests__/fixtures/ink-repaint-stream';
import { WSContext } from 'hono/ws';
import type { WorkerServerMessage } from '@agent-console/shared';

const TEST_CONFIG_DIR = '/test/config';
const ptyFactory = createMockPtyFactory();

const COLS = 100;
const ROWS = 24;
const FRAMES = 340;
const LABEL = /\[F(\d{3}):L(\d{2})\]/;
const CONTENT_LINES = 20;
const CHROME_REPAINTS = 12;
const STATUS_BAR = 'ctx:4% | Sonnet 5 | ms2sato@ca-mini tmp ... /rc';
// ~1.3KB per frame; a cut archives ~20% of this, so a segment holds several
// frames (more rows than the viewport) and the stream cuts into well over 6.
// The cut leaves ~512KB (the display floor) in the live file, so the attach window holds
// more rows than the client's live scrollback (5000) and its first rows are dropped.
const FILE_MAX_SIZE = 600_000;
// Not frame-aligned: the archive cut and the attach window start mid-frame.
const WRITE_CHUNK_BYTES = 8192;

type RangeMessage = Extract<WorkerServerMessage, { type: 'history-range' }>;
type HistoryMessage = Extract<WorkerServerMessage, { type: 'history' }>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Frame-major index of a content label, or null when the row carries none. */
function labelIndex(text: string): number | null {
  const m = text.match(LABEL);
  return m ? (Number(m[1]) - 1) * CONTENT_LINES + Number(m[2]) : null;
}

function labelOf(text: string): string | null {
  return text.match(LABEL)?.[0] ?? null;
}

describe('Client-Server Boundary: paged rows meet the live window (#2176)', () => {
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

  async function countSegments(sessionId: string, workerId: string): Promise<number> {
    let units = 0;
    let before = await sessionManager.getCurrentOutputOffset(sessionId, workerId);
    for (let guard = 0; guard < 1000 && before > 0; guard++) {
      const range = await sessionManager.getWorkerHistoryRange(sessionId, workerId, before);
      if (!range || range.data === '') break;
      units++;
      before = range.startOffset;
    }
    return Math.max(0, units - 1);
  }

  interface PagingHarness {
    instance: ReturnType<typeof getOrCreateTerminal>;
    ws: MockWebSocket;
    wsCtx: WSContext;
    sent: WorkerServerMessage[];
    sessionId: string;
    workerId: string;
  }

  /** Page the store back through the real range handler until the archive or the paged cap ends it. */
  async function pageToTop(h: PagingHarness): Promise<{ replies: RangeMessage[]; requests: number; firstBeforeOffset: number | null }> {
    const { instance, ws, wsCtx, sent, sessionId, workerId } = h;
    const replies: RangeMessage[] = [];
    const rangeRequests = (): Array<{ type: string; beforeOffset: number; maxBytes: number }> =>
      [...ws.send.mock.calls].map((c) => JSON.parse(c[0])).filter((m) => m.type === 'request-history-range');
    let requests = 0;
    let served = 0;
    let idleSpins = 0;
    let awaitedFrom: number | null = null; // oldestOffset when the last reply was delivered
    instance.requestOlderHistory();
    while (true) {
      // Serve every range request the store has issued (an overflow re-requests the same range smaller).
      const pending = rangeRequests();
      if (served < pending.length) {
        idleSpins = 0;
        const req = pending[served++];
        requests++;
        const sentBefore = sent.length;
        await handleHistoryRangeRequest(wsCtx, sessionId, workerId, req, sessionManager);
        const reply = sent[sentBefore] as RangeMessage;
        expect(reply.type).toBe('history-range');
        replies.push(reply);
        awaitedFrom = _inspect(instance).paging.oldestOffset;
        ws.simulateMessage(JSON.stringify(reply));
        if (requests > 400) throw new Error('paging did not terminate');
        continue;
      }
      const paging = _inspect(instance).paging;
      const applied = awaitedFrom === null || paging.oldestOffset !== awaitedFrom || !paging.hasMoreHistory;
      if (!paging.loadingOlder && applied) {
        if (!paging.hasMoreHistory || paging.pagedCapReached) break;
        awaitedFrom = null;
        instance.requestOlderHistory();
        await sleep(5);
        if (++idleSpins > 2000) throw new Error('requestOlderHistory sent nothing ' + JSON.stringify(_inspect(instance).paging) + ' served=' + served + ' requests=' + requests);
        continue;
      }
      await sleep(5);
    }
    await _whenIdle();
    return { replies, requests, firstBeforeOffset: rangeRequests()[0]?.beforeOffset ?? null };
  }

  async function attachAndPageToTop() {
    const session = await sessionManager.createSession({ type: 'quick', locationPath: '/test/path', agentId: 'claude-code' });
    const sessionId = session.id;
    const workerId = session.workers.find((w) => w.type === 'agent')!.id;

    const stream = generateInkRepaintStream({ frames: FRAMES, cols: COLS, statusBar: STATUS_BAR, contentLinesPerFrame: CONTENT_LINES, chromeRepaintsPerFrame: CHROME_REPAINTS });
    const frameBytes = WRITE_CHUNK_BYTES;
    for (let at = 0; at < stream.length; at += frameBytes) {
      ptyFactory.instances[0].simulateData(stream.slice(at, at + frameBytes));
      await outputManager.flushAll();
    }
    const segments = await countSegments(sessionId, workerId);

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
    instance.resize(COLS, ROWS);

    // A real attach: the server's initial window, rendered into the live controller.
    const history = await sessionManager.getWorkerOutputHistory(sessionId, workerId, 0, serverConfig.WORKER_OUTPUT_INITIAL_HISTORY_LINES);
    if (!history) throw new Error('no history');
    const historyMsg: HistoryMessage = { type: 'history', data: history.data, offset: history.offset, startOffset: history.startOffset, epoch: history.epoch };
    ws.simulateMessage(JSON.stringify(historyMsg));
    await _whenIdle();
    expect(_inspect(instance).paging.hasMoreHistory).toBe(true);

    const { replies, requests } = await pageToTop({ instance, ws, wsCtx, sent, sessionId, workerId });
    await _whenIdle();

    const rows = instance.getSnapshot().rows;
    const pagedTexts = rows.filter((r) => r.key < 0).map(rowText);
    const liveTexts = rows.filter((r) => r.key >= 0).map(rowText);
    expect(pagedTexts.length).toBe(_inspect(instance).paging.pagedRowCount);
    return { stream, history, segments, requests, replies, pagedTexts, liveTexts };
  }

  /** Duplicate labels and backwards steps over paged ++ live; indices relative to pagedRowCount. */
  function measure(pagedTexts: string[], liveTexts: string[]) {
    const all = [...pagedTexts, ...liveTexts];
    const pagedCount = pagedTexts.length;
    const seen = new Map<string, number>();
    const duplicateIdx: number[] = [];
    all.forEach((text, i) => {
      const label = labelOf(text);
      if (label === null) return;
      if (seen.has(label)) duplicateIdx.push(i - pagedCount);
      else seen.set(label, i);
    });
    const backwards: number[] = [];
    let previous = 0;
    all.forEach((text, i) => {
      const idx = labelIndex(text);
      if (idx === null) return;
      if (idx < previous) backwards.push(i - pagedCount);
      previous = idx;
    });
    return { pagedCount, duplicateIdx, backwards };
  }

  const esc = (value: unknown): string => JSON.stringify(value);

  /** Label gap measured by the attach scenario, read by the gap case below. */
  let attachGap: number | undefined;

  // The attach path is clean: 'keep' on the first fetch is RIGHT. The newest paged
  // chunk's kept volatile tail (ROWS - 1 = 23 rows) is genuine content that no live row
  // repeats; yielding it would lose it (113 labels missing in total in this scenario,
  // 90 + 23). Do not re-propose 'yield-to-newer' for the first fetch.
  it('attach path: no duplicated label and no backwards step over the paged rows followed by the live rows', async () => {
    const r = await attachAndPageToTop();
    const { pagedTexts, liveTexts, history, stream } = r;
    const m = measure(pagedTexts, liveTexts);
    const startOffset = history.startOffset ?? 0;
    console.log(`[live-boundary] segments=${r.segments} requests=${r.requests} streamBytes=${stream.length} liveStartOffset=${startOffset} historyBytes=${history.data.length}`);
    console.log(`[live-boundary] pagedRows=${pagedTexts.length} liveRows=${liveTexts.length}`);
    console.log(
      `[live-boundary] (a) duplicatedRows=${m.duplicateIdx.length} first=${m.duplicateIdx[0]} last=${m.duplicateIdx[m.duplicateIdx.length - 1]} (indices relative to pagedRowCount; negative = paged side)`,
    );
    console.log(`[live-boundary] (b) backwardsSteps=${m.backwards.length} at=${JSON.stringify(m.backwards)}`);

    // (c) the first fetch is the newest paged chunk; replay its bytes alone.
    const first = r.replies[0];
    const keep = await replayHistoryJoint([first.data], COLS, ROWS, (d) => d, 'keep');
    const yielded = await replayHistoryJoint([first.data], COLS, ROWS, (d) => d, 'yield-to-newer');
    const keptTail = keep.partitions[0].length - yielded.partitions[0].length;
    console.log(
      `[live-boundary] (c) firstFetch bytes=${first.data.length} start=${first.startOffset} end=${first.endOffset} keepRows=${keep.partitions[0].length} yieldRows=${yielded.partitions[0].length} keptVolatileTail=${keptTail}`,
    );
    const keepTexts = keep.partitions[0].map(rowText);
    console.log(`[live-boundary] (c) keep tail text=${esc(keepTexts.slice(-keptTail - 1).map((t) => t.trimEnd().slice(0, 30)).join(' | '))}`);

    // (d) the live window's first rows
    console.log(`[live-boundary] (d) first live rows=\n${liveTexts.slice(0, 8).map((t, i) => `  live[${i}]=${esc(t.trimEnd())}`).join('\n')}`);
    console.log(`[live-boundary] (d) last paged rows=\n${pagedTexts.slice(-4).map((t, i) => `  paged[-${4 - i}]=${esc(t.trimEnd())}`).join('\n')}`);

    const lastPaged = [...pagedTexts].reverse().map(labelIndex).find((x) => x !== null) ?? 0;
    const firstLive = liveTexts.map(labelIndex).find((x) => x !== null) ?? 0;
    const labelsBetween = firstLive - lastPaged - 1;
    console.log(`[live-boundary] (d) label gap across the boundary: lastPagedLabelIndex=${lastPaged} firstLiveLabelIndex=${firstLive} labelsBetween=${labelsBetween}`);
    console.log(`[live-boundary] (d) first 30 live rows: ${esc(liveTexts.slice(0, 30).map((t) => t.trimEnd().slice(0, 10)))}`);
    const liveReplay = await replayHistoryJoint([history.data], COLS, ROWS, (d) => d, 'keep');
    console.log(`[live-boundary] (d) standalone replay of the live window bytes: first 24 rows=${esc(liveReplay.partitions[0].slice(0, 24).map((r) => rowText(r).trimEnd().slice(0, 10)))}`);
    console.log(`[live-boundary] (d) history.data head=${esc(history.data.slice(0, 60))}`);
    // (e) live window byte start vs the frame structure
    console.log(`[live-boundary] (e) before=${esc(stream.slice(Math.max(0, startOffset - 80), startOffset))}`);
    console.log(`[live-boundary] (e) after =${esc(stream.slice(startOffset, startOffset + 80))}`);
    console.log(`[live-boundary] (e) history.data starts with stream[startOffset]: ${stream.slice(startOffset, startOffset + 40) === history.data.slice(0, 40)}`);
    const climbs = '\x1b[2A\r';
    const lastClimb = stream.lastIndexOf(climbs, startOffset);
    const nextClimb = stream.indexOf(climbs, startOffset);
    const priorLabel = [...stream.slice(0, startOffset).matchAll(/\[F\d{3}:L\d{2}\]/g)].pop();
    console.log(`[live-boundary] (e) bytesSincePrecedingChromeClimb=${startOffset - lastClimb} bytesToNextClimb=${nextClimb - startOffset} lastLabelBeforeStart=${priorLabel?.[0]}`);

    // Yield simulation: drop the kept tail from the end of the paged side.
    const yieldedPaged = pagedTexts.slice(0, pagedTexts.length - keptTail);
    const my = measure(yieldedPaged, liveTexts);
    const labels = [...yieldedPaged, ...liveTexts].map(labelIndex).filter((x): x is number => x !== null);
    const have = new Set(labels);
    const missing: number[] = [];
    for (let i = 1; i <= FRAMES * CONTENT_LINES; i++) if (!have.has(i)) missing.push(i);
    console.log(
      `[live-boundary] yield-sim: pagedRows=${yieldedPaged.length} duplicatedRows=${my.duplicateIdx.length} backwardsSteps=${my.backwards.length} missingLabels=${missing.length} ${JSON.stringify(missing.slice(0, 12))}`,
    );

    // Measured state (Issue #2176; deterministic, no timing): the live window starts
    // mid-stream and mid-frame; nothing repeats and nothing runs backwards over
    // paged ++ live. The newest paged chunk's 'keep' tail is ROWS - 1 genuine content
    // rows that no live row repeats (yielding them would lose them), and the rows
    // missing at the boundary are the live window's OWN top rows dropped by the
    // client's 5000-row live scrollback, not rows the paged side repeats (see the
    // gap case below).
    expect(r.segments).toBeGreaterThanOrEqual(3);
    expect(startOffset).toBeGreaterThan(0);
    expect(m.duplicateIdx).toEqual([]);
    expect(m.backwards).toEqual([]);
    expect(keptTail).toBe(ROWS - 1);
    expect(missing.length).toBeGreaterThanOrEqual(keptTail);
    attachGap = labelsBetween;
    expect(liveTexts.slice(0, 8).every((t) => /^\[F\d{3}:L\d{2}\] the quick brown fox jumps over the lazy dog\s*$/.test(t))).toBe(true);
  }, 120_000);

  // Live-streamed-then-paged flow: the client attaches mid-stream, then the rest of the
  // stream arrives as real `output` frames while the server cuts segments (the browser
  // case of Issue #2176).
  const STREAMED_FRAMES = 1200;

  async function streamThenPage(attachAtBytes: number) {
    const session = await sessionManager.createSession({ type: 'quick', locationPath: '/test/path', agentId: 'claude-code' });
    const sessionId = session.id;
    const workerId = session.workers.find((w) => w.type === 'agent')!.id;
    const stream = generateInkRepaintStream({ frames: STREAMED_FRAMES, cols: COLS, statusBar: STATUS_BAR, contentLinesPerFrame: CONTENT_LINES, chromeRepaintsPerFrame: CHROME_REPAINTS });

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
    instance.resize(COLS, ROWS);

    // Server side only, up to the attach point.
    let at = 0;
    for (; at < attachAtBytes; at += WRITE_CHUNK_BYTES) {
      ptyFactory.instances[0].simulateData(stream.slice(at, at + WRITE_CHUNK_BYTES));
      await outputManager.flushAll();
    }
    const attachedAt = Math.min(at, stream.length);
    const history = await sessionManager.getWorkerOutputHistory(sessionId, workerId, 0, serverConfig.WORKER_OUTPUT_INITIAL_HISTORY_LINES);
    if (!history) throw new Error('no history');
    const historyMsg: HistoryMessage = { type: 'history', data: history.data, offset: history.offset, startOffset: history.startOffset, epoch: history.epoch };
    ws.simulateMessage(JSON.stringify(historyMsg));
    await _whenIdle();

    const seeds: string[] = [];
    let lastSeed = '';
    const noteSeed = (label: string): void => {
      const p = _inspect(instance).paging;
      const seed = `liveStartOffset=${p.liveStartOffset} liveEvictedUpTo=${p.liveEvictedUpTo} oldestOffset=${p.oldestOffset} hasMoreHistory=${p.hasMoreHistory} frameMarkers=${p.frameMarkerCount}`;
      if (seed !== lastSeed) {
        seeds.push(`${label}: ${seed}`);
        console.log(`[live-streamed] ${label}: ${seed}`);
        lastSeed = seed;
      }
    };
    noteSeed(`attach (history startOffset=${history.startOffset} offset=${history.offset} bytes=${history.data.length})`);
    const attachSeed = _inspect(instance).paging;

    // The rest of the stream: server write + flush, then the same bytes as an `output` frame.
    let received = history.data.length;
    for (; at < stream.length; at += WRITE_CHUNK_BYTES) {
      const chunk = stream.slice(at, at + WRITE_CHUNK_BYTES);
      ptyFactory.instances[0].simulateData(chunk);
      await outputManager.flushAll();
      const end = at + chunk.length;
      ws.simulateMessage(JSON.stringify({ type: 'output', data: chunk, offset: end, epoch: history.epoch }));
      received += chunk.length;
      noteSeed(`after output offset=${end}`);
    }
    await _whenIdle();
    noteSeed('stream end');

    // Server cut points (segment boundaries in stream offsets), newest first.
    const boundaries: number[] = [];
    let before = await sessionManager.getCurrentOutputOffset(sessionId, workerId);
    for (let guard = 0; guard < 1000 && before > 0; guard++) {
      const range = await sessionManager.getWorkerHistoryRange(sessionId, workerId, before);
      if (!range || range.data === '') break;
      boundaries.push(range.startOffset);
      before = range.startOffset;
    }

    const liveBefore = instance.getSnapshot().rows.filter((r) => r.key >= 0).map(rowText);
    const firstInspect = { ..._inspect(instance).paging };
    const paging = await pageToTop({ instance, ws, wsCtx, sent, sessionId, workerId });
    const rows = instance.getSnapshot().rows;
    const pagedTexts = rows.filter((r) => r.key < 0).map(rowText);
    const liveTexts = rows.filter((r) => r.key >= 0).map(rowText);
    return { stream, history, attachedAt, attachSeed, received, boundaries, liveBefore, pagedTexts, liveTexts, firstInspect, ...paging };
  }

  function reportStreamed(r: Awaited<ReturnType<typeof streamThenPage>>) {
    const { stream, pagedTexts, liveTexts } = r;
    const m = measure(pagedTexts, liveTexts);
    const firstLiveLabel = liveTexts.map(labelOf).find((l) => l !== null) ?? null;
    const firstLiveIdx = liveTexts.map(labelIndex).find((x) => x !== null) ?? 0;
    const lastPagedIdx = [...pagedTexts].reverse().map(labelIndex).find((x) => x !== null) ?? 0;
    const topOffset = firstLiveLabel === null ? -1 : stream.indexOf(`\x1b[K${firstLiveLabel}`);
    console.log(`[live-streamed] fileMaxSize=${FILE_MAX_SIZE} streamBytes=${stream.length} attachedAtBytes=${r.attachedAt} segmentBoundaries(newest first)=${JSON.stringify(r.boundaries)}`);
    console.log(`[live-streamed] attach seed liveStartOffset=${r.attachSeed.liveStartOffset} oldestOffset=${r.attachSeed.oldestOffset}; first request-history-range beforeOffset=${r.firstBeforeOffset}`);
    console.log(`[live-streamed] bytes the live controller received=${r.received} rows retained before paging=${r.liveBefore.length} (SCROLLBACK 5000 + ${ROWS}); rows after paging: paged=${pagedTexts.length} live=${liveTexts.length}`);
    console.log(`[live-streamed] firstRetainedLiveLabel=${firstLiveLabel} its line starts at stream offset ${topOffset}; first beforeOffset - that offset = ${(r.firstBeforeOffset ?? 0) - topOffset} bytes`);
    console.log(`[live-streamed] label gap: lastPagedLabelIndex=${lastPagedIdx} firstLiveLabelIndex=${firstLiveIdx} labelsBetween=${firstLiveIdx - lastPagedIdx - 1}`);
    console.log(
      `[live-streamed] duplicatedRows=${m.duplicateIdx.length} first=${m.duplicateIdx[0]} last=${m.duplicateIdx[m.duplicateIdx.length - 1]} backwardsSteps=${m.backwards.length} at=${JSON.stringify(m.backwards)} (indices relative to pagedRowCount=${m.pagedCount})`,
    );
    return { m, gap: firstLiveIdx - lastPagedIdx - 1, topOffset };
  }

  // Fixed by the live-edge accounting (design section 6.5, Issue #2176). Measured record,
  // before the fix, with the paging cursor seeded from the attach window's start:
  //   - attach replay larger than SCROLLBACK (340 frames, 24 rows): 90 labels missing between the
  //     last paged row and the first live row; the 2.4 MB attach scenario: rows 24 -> 19 missing,
  //     30 -> 13, 38 -> 5, 45 -> 0;
  //   - live-streamed flow below (attach at 704512 bytes, then output frames): 17203 labels
  //     missing (18975 in the browser); an attach at offset 0 could not page at all.
  // After the fix the gap is bounded by the span of one marker, a line-aligned piece of about
  // LIVE_EDGE_PIECE_BYTES (4096) bytes on attach and on the stream alike. Duplicates and
  // backwards steps are 0.
  const LABELS_PER_STREAM_BYTE = (STREAMED_FRAMES * CONTENT_LINES) / 2_466_424;
  // One piece may overshoot its target to the next line head: allow 1.5 targets.
  const PIECE_GAP_BOUND_LABELS = Math.ceil(4096 * 1.5 * LABELS_PER_STREAM_BYTE);
  const ATTACH_GAP_BOUND_LABELS = PIECE_GAP_BOUND_LABELS;
  const STREAM_GAP_BOUND_LABELS = PIECE_GAP_BOUND_LABELS;

  it('attach path: the labels missing at the boundary are bounded by one piece', () => {
    if (attachGap === undefined) throw new Error('the attach scenario did not run');
    expect(attachGap).toBeLessThanOrEqual(ATTACH_GAP_BOUND_LABELS);
  });

  it('live-streamed then paged: the first fetch starts at the live edge and no label repeats or runs backwards', async () => {
    const r = await streamThenPage(700_000);
    const { m, gap, topOffset } = reportStreamed(r);
    const first = r.firstInspect;
    console.log(
      `[live-streamed] at the first fetch: liveStartOffset=${first.liveStartOffset} liveEvictedUpTo=${first.liveEvictedUpTo} oldestOffset=${first.oldestOffset}; gap=${gap} labels (bound ${STREAM_GAP_BOUND_LABELS}); top of the live buffer at stream offset ${topOffset}`,
    );
    expect(m.duplicateIdx).toEqual([]);
    expect(m.backwards).toEqual([]);
    expect(r.boundaries.length).toBeGreaterThanOrEqual(3);
    expect(first.liveStartOffset).toBeGreaterThan(0);
    expect(first.oldestOffset).toBe(first.liveEvictedUpTo);
    expect(first.liveEvictedUpTo).toBeGreaterThan(first.liveStartOffset);
    expect(r.firstBeforeOffset).toBe(first.oldestOffset);
    expect(gap).toBeLessThanOrEqual(STREAM_GAP_BOUND_LABELS);
  }, 120_000);

  it('attach at offset 0 then stream: the first fetch is sent once eviction has happened', async () => {
    const r = await streamThenPage(0);
    const { m, gap } = reportStreamed(r);
    const first = r.firstInspect;
    console.log(`[live-streamed] attach at 0: at the first fetch liveStartOffset=${first.liveStartOffset} liveEvictedUpTo=${first.liveEvictedUpTo} hasMoreHistory=${first.hasMoreHistory}; gap=${gap}`);
    expect(first.liveStartOffset).toBe(0);
    expect(first.hasMoreHistory).toBe(true);
    expect(r.firstBeforeOffset).toBe(first.liveEvictedUpTo);
    expect(r.firstBeforeOffset).toBeGreaterThan(0);
    expect(m.duplicateIdx).toEqual([]);
    expect(m.backwards).toEqual([]);
    expect(gap).toBeLessThanOrEqual(STREAM_GAP_BOUND_LABELS);
  }, 120_000);

  // Trip the 512-entry cap on purpose with tiny pieces: the marker the merge gave up is
  // disposed in xterm too, and the labels missing at the boundary stay within the span
  // between the eviction cursor and the oldest surviving marker, computed from the
  // recorded end offsets.
  it('cap tripped on purpose: no marker leaks and the gap stays within one merged span', async () => {
    _setLiveEdgePieceBytesForTest(200);
    try {
      const r = await streamThenPage(700_000);
      const { gap, topOffset } = reportStreamed(r);
      const first = r.firstInspect;
      const oldestSurvivor = first.frameMarkerEndOffsets[0];
      const spanBytes = oldestSurvivor - first.liveEvictedUpTo;
      const gapBytes = topOffset - first.liveEvictedUpTo;
      console.log(
        `[live-streamed] cap tripped: frameMarkerCount=${first.frameMarkerCount} liveMarkerCount=${first.liveMarkerCount} liveEvictedUpTo=${first.liveEvictedUpTo} oldest surviving marker end=${oldestSurvivor} (merged span ${spanBytes} bytes); live top at ${topOffset} (${gapBytes} bytes above the cursor); gap=${gap} labels`,
      );
      expect(first.frameMarkerCount).toBe(512);
      expect(first.liveMarkerCount).toBe(first.frameMarkerCount);
      expect(gapBytes).toBeLessThanOrEqual(spanBytes);
      expect(gap).toBeLessThanOrEqual(Math.ceil(spanBytes * LABELS_PER_STREAM_BYTE));
      expect(r.pagedTexts.length).toBeGreaterThan(0);
      const { m } = reportStreamed(r);
      expect(m.duplicateIdx).toEqual([]);
      expect(m.backwards).toEqual([]);
    } finally {
      _setLiveEdgePieceBytesForTest(null);
    }
  }, 120_000);
});
