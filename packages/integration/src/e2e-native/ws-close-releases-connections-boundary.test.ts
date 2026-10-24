/**
 * Shipping-path Boundary Test: closing a WebSocket releases every connection-tracking entry.
 *
 * Real: a Hono app with the real `setupWebSocketRoutes`, a real `Bun.serve` with Hono's Bun
 * `upgradeWebSocket` (which builds a NEW `WSContext` for each of open / message / close), real native
 * `WebSocket` clients, the real connection registry, the real git-diff and file-viewer handlers, and a real
 * git repository on disk for the git-diff worker.
 *
 * Recorded proxy: the PTY provider is the mock one (no real agent is spawned); the filesystem layer is memfs
 * for server-side fs reads while git itself runs on the real directory.
 *
 * Instruments: the registry's private collections are read by reflection; the handlers' open-connection counts
 * come from their test-only `activeConnectionCount()` accessors. Positive controls in this file: the PTY worker's
 * `connectionCallbacks` (keyed by a string id) drops on close, and a fake context removed with the SAME object
 * returns every collection to baseline.
 *
 * This file lives in e2e-native/ because a real `Bun.serve` needs pristine native `Response` / `Headers`.
 * NOTE: packages/integration uses a FLAT sibling test layout (no __tests__/).
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Hono } from 'hono';
import { upgradeWebSocket, websocket } from 'hono/bun';

import { setupTestEnvironment, cleanupTestEnvironment } from '@agent-console/server/src/__tests__/test-utils';
import { setupMemfs } from '@agent-console/server/src/__tests__/utils/mock-fs-helper';
import { createMockPtyProvider } from '@agent-console/server/src/__tests__/utils/mock-pty';
import { createTestContext, shutdownAppContext } from '@agent-console/server/src/app-context';
import type { AppContext } from '@agent-console/server/src/app-context';
import { setupWebSocketRoutes } from '@agent-console/server/src/websocket/routes';
import { isInternalPtyWorker } from '@agent-console/server/src/services/worker-types';
import { asWSContext } from '@agent-console/server/src/websocket/__tests__/ws-test-helpers';
import { sanitizeInheritedGitEnv } from '@agent-console/server/src/__tests__/utils/scratch-git';
import { WebSocketConnectionRegistry } from '@agent-console/server/src/websocket/connection-registry';
import { getGitDiffActiveConnectionCount } from '@agent-console/server/src/websocket/git-diff-handler';
import { getFileViewerActiveConnectionCount } from '@agent-console/server/src/websocket/file-viewer-handler';

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(c: () => boolean, what: string, t = 5000) {
  const d = Date.now() + t;
  while (!c()) {
    if (Date.now() > d) throw new Error('timeout waiting for ' + what);
    await delay(5);
  }
}

/** The `type` of a parsed frame, or undefined when the frame has none. */
function frameType(frame: unknown): string | undefined {
  if (typeof frame !== 'object' || frame === null || !('type' in frame)) return undefined;
  return typeof frame.type === 'string' ? frame.type : undefined;
}

type Snapshot = Record<string, number>;

/**
 * Remove the temp repo from the REAL disk without a recursive-delete flag: node:fs is memfs-backed in this
 * process, so use Bun's real-fs file API, delete the files, then remove the emptied directories deepest first.
 */
async function removeRealDirectory(dir: string): Promise<void> {
  if (!dir) return;
  const dirs: string[] = [];
  for await (const entry of new Bun.Glob('**/*').scan({ cwd: dir, dot: true, onlyFiles: false })) {
    const full = `${dir}/${entry}`;
    if (await Bun.file(full).exists()) await Bun.file(full).delete();
    else dirs.push(full);
  }
  dirs.sort((x, y) => y.length - x.length);
  for (const d of dirs) Bun.spawnSync(['rmdir', d]);
  Bun.spawnSync(['rmdir', dir]);
}

describe('Shipping path: closing a socket releases its connection entries', () => {
  let ctx: AppContext;
  let registry: WebSocketConnectionRegistry;
  let server: ReturnType<typeof Bun.serve>;
  let repoDir = '';
  let gitConfigDir = '';
  let sessionId = '';
  let ptyWorkerId = '';
  let diffWorkerId = '';
  let viewerWorkerId = '';

  beforeAll(async () => {
    // A real git repository so the git-diff worker can produce a real diff-data frame.
    // (Bun.spawnSync / Bun.write act on the real disk; node:fs is memfs-backed in this process.)
    repoDir = Bun.spawnSync(['mktemp', '-d']).stdout.toString().trim();
    // Hermetic git for the scratch repo only: the same throwaway global config (fixed identity, signing off,
    // default branch main, empty hooks path), GIT_CONFIG_GLOBAL + GIT_CONFIG_NOSYSTEM and env sanitizing as
    // createScratchGitRepo in server/src/__tests__/utils/scratch-git.ts, so the operator's signing program, hooks
    // and aliases are never read. That helper cannot be used here: its mkdir / mkdtemp / writeFile (node:fs/promises,
    // lines 20 and 224-262) are memfs-backed in this process, so the repo it makes exists only in memory and its
    // Bun.spawn git (runGit, line 218) then fails with ENOENT on the missing cwd. Only its pure
    // sanitizeInheritedGitEnv is reused.
    gitConfigDir = Bun.spawnSync(['mktemp', '-d']).stdout.toString().trim();
    await Bun.write(`${gitConfigDir}/hooks-empty/.keep`, '');
    await Bun.write(
      `${gitConfigDir}/gitconfig`,
      [
        '[user]',
        '\tname = Scratch',
        '\temail = scratch@example.com',
        '[commit]',
        '\tgpgsign = false',
        '[init]',
        '\tdefaultBranch = main',
        '[core]',
        `\thooksPath = ${gitConfigDir}/hooks-empty`,
        '',
      ].join('\n'),
    );
    const gitEnv: Record<string, string> = {
      ...sanitizeInheritedGitEnv(process.env),
      GIT_CONFIG_GLOBAL: `${gitConfigDir}/gitconfig`,
      GIT_CONFIG_NOSYSTEM: '1',
    };
    const git = (...args: string[]) => {
      const r = Bun.spawnSync(['git', ...args], { cwd: repoDir, env: gitEnv });
      if (r.exitCode !== 0) {
        throw new Error(`test setup failed: scratch repo step 'git ${args.join(' ')}' exited ${r.exitCode}: ${r.stderr.toString()}`);
      }
    };
    git('init', '-q', '-b', 'main');
    await Bun.write(`${repoDir}/a.txt`, 'one\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    await Bun.write(`${repoDir}/a.txt`, 'one\ntwo\n');

    await setupTestEnvironment();
    setupMemfs({ '/test/config/.keep': '', [`${repoDir}/.keep`]: '' });
    ctx = await createTestContext({ ptyProvider: createMockPtyProvider() });
    registry = new WebSocketConnectionRegistry();
    const app = new Hono();
    await setupWebSocketRoutes(app, upgradeWebSocket, ctx, registry);
    server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: app.fetch, websocket });

    const session = await ctx.sessionManager.createSession({ type: 'quick', locationPath: repoDir, agentId: 'claude-code' });
    sessionId = session.id;
    ptyWorkerId = session.workers.find((w) => w.type === 'agent')!.id;
    diffWorkerId = session.workers.find((w) => w.type === 'git-diff')!.id;
    const viewer = await ctx.sessionManager.createWorker(sessionId, { type: 'file-viewer' });
    viewerWorkerId = viewer!.id;
  });

  afterAll(async () => {
    await server?.stop(true);
    if (ctx) await shutdownAppContext(ctx);
    await cleanupTestEnvironment();
    await removeRealDirectory(repoDir);
    await removeRealDirectory(gitConfigDir);
  });

  function snapshot(): Snapshot {
    const out: Snapshot = {};
    for (const [name, val] of Object.entries(registry) as Array<[string, unknown]>) {
      if (val instanceof Map) {
        out['registry.' + name] = val.size;
        let inner = 0;
        let hasInner = false;
        for (const x of val.values()) {
          if (x instanceof Set || x instanceof Map) {
            inner += x.size;
            hasInner = true;
          }
        }
        if (hasInner) out['registry.' + name + ' [inner members]'] = inner;
      } else if (val instanceof Set) {
        out['registry.' + name] = val.size;
      }
    }
    out['gitDiffHandler.activeConnections'] = getGitDiffActiveConnectionCount();
    out['fileViewerHandler.activeConnections'] = getFileViewerActiveConnectionCount();
    const w = ctx.sessionManager.getWorker(sessionId, ptyWorkerId);
    out['ptyWorker.connectionCallbacks'] = w && isInternalPtyWorker(w) ? w.connectionCallbacks.size : 0;
    return out;
  }

  /** Open a socket, run `exercise` while attached, close from the client, settle, compare to a baseline taken just before the open. */
  async function openAndCloseClient(
    urlPath: string,
    attached: () => boolean,
    exercise?: (client: WebSocket, frames: unknown[]) => Promise<void>,
  ) {
    const baseline = snapshot();
    const frames: unknown[] = [];
    const client = new WebSocket(`ws://127.0.0.1:${server.port}${urlPath}`);
    client.addEventListener('message', (e) => {
      try {
        frames.push(JSON.parse(String(e.data)));
      } catch {
        /* binary frame */
      }
    });
    const closed = new Promise<void>((r) => client.addEventListener('close', () => r()));
    await waitFor(attached, 'the socket to attach');
    await delay(150);
    const open = snapshot();
    if (exercise) await exercise(client, frames);
    client.close();
    await closed;
    await delay(500);
    return { baseline, open, after: snapshot() };
  }

  it('/ws/app: close returns every collection to baseline', async () => {
    const before = registry.appClientCount;
    const { baseline, after } = await openAndCloseClient('/ws/app', () => registry.appClientCount > before);
    expect(after).toEqual(baseline);
  });

  it('PTY worker: close returns every collection to baseline (connectionCallbacks is the keyed-by-string control)', async () => {
    const { baseline, open, after } = await openAndCloseClient(
      `/ws/session/${sessionId}/worker/${ptyWorkerId}`,
      () => (registry.getWorkerConnections(sessionId, ptyWorkerId)?.size ?? 0) > 0 && snapshot()['ptyWorker.connectionCallbacks'] > 0,
    );
    // The instrument sees changes: callbacks went up while open ...
    expect(open['ptyWorker.connectionCallbacks']).toBe(baseline['ptyWorker.connectionCallbacks'] + 1);
    expect(after).toEqual(baseline);
  });

  it('git-diff worker: refresh is answered with diff-data, and close returns every collection to baseline', async () => {
    let refreshFrames: unknown[] = [];
    const { baseline, after } = await openAndCloseClient(
      `/ws/session/${sessionId}/worker/${diffWorkerId}`,
      () => getGitDiffActiveConnectionCount() > 0,
      async (client, frames) => {
        await waitFor(() => frames.some((f) => frameType(f) === 'diff-data'), 'the initial diff-data frame');
        frames.length = 0;
        client.send(JSON.stringify({ type: 'refresh' }));
        await waitFor(() => frames.length > 0, 'a reply to refresh').catch(() => undefined);
        await delay(200);
        refreshFrames = [...frames];
      },
    );
    // Polarity: with a per-event context the handler answers { type: 'diff-error', error: 'No active connection for this worker' }.
    expect(refreshFrames.filter((f) => frameType(f) === 'diff-error' || frameType(f) === 'error')).toEqual([]);
    expect(refreshFrames.map(frameType)).toContain('diff-data');
    expect(after).toEqual(baseline);
  });

  it('file-viewer worker: close returns every collection to baseline', async () => {
    const { baseline, after } = await openAndCloseClient(
      `/ws/session/${sessionId}/worker/${viewerWorkerId}`,
      () => getFileViewerActiveConnectionCount() > 0,
    );
    expect(after).toEqual(baseline);
  });

  it('positive control: removing a context with the SAME object returns every collection to baseline', () => {
    const baseline = snapshot();
    const fake = asWSContext({ send() {}, close() {} });
    registry.addAppClient(fake);
    registry.startSyncing(fake);
    registry.addWorkerConnection(sessionId, ptyWorkerId, fake);
    registry.setConnectionMetadata(fake, { sessionId, workerId: ptyWorkerId, connectionId: 'control' });
    const open = snapshot();
    expect(open).not.toEqual(baseline);
    // The inner-member metric is recorded (it reads the per-key Maps of send handles) and sees the connection.
    for (const key of ['registry.workerConnectionsBySession [inner members]', 'registry.workerConnections [inner members]']) {
      expect(open[key]).toBe((baseline[key] ?? 0) + 1);
    }
    registry.removeAppClient(fake);
    registry.removeWorkerConnection(sessionId, ptyWorkerId, fake);
    expect(snapshot()).toEqual(baseline);
  });
});
