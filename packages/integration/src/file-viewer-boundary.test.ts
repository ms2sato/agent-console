/**
 * Client-Server Boundary Test: the file viewer worker (CLAUDE.md pre-PR Q10)
 *
 * The file viewer adds a worker variant to the shared worker union and two
 * read-only routes. Server unit tests build the worker and the responses as
 * in-memory objects; client unit tests inject mock objects. Neither proves that
 * what the REAL server emits survives the schemas the client parses with, which
 * is the layer where a missing schema entry silently drops a whole message
 * (strict schemas reject the frame; the client logs and discards it).
 *
 * This test exercises the real chain:
 *   real HTTP POST /api/sessions/:id/workers { type: 'file-viewer' }
 *     -> real vValidator(CreateWorkerRequestSchema) -> real route
 *     -> real SessionManager.createWorker -> worker appears in the session
 *   -> buildSessionsSyncMessage -> JSON -> AppServerMessageSchema.safeParse
 *      (the frame the client receives; the worker must be `type: 'file-viewer'`)
 *   real HTTP GET .../files/tree and .../files/content on a seeded working
 *   directory (dotfile, nested directory, a symlink inside, a `.git` directory,
 *   a text file, a binary file, a file of 1 MiB + 1 byte)
 *     -> JSON -> FileTreeResponseSchema / FileContentResponseSchema.parse
 *
 * Placement note: this package's boundary tests run on the in-memory
 * filesystem every server test fixture shares (`setupTestEnvironment`), which
 * models symlinks, realpath and large files; the behaviours that need a real
 * kernel (fifo, a real `sh`, find output) are covered against real files in
 * `packages/server`'s real-fs test files.
 *
 * NOTE: packages/integration uses a FLAT sibling test layout (no __tests__/).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs/promises';
import * as v from 'valibot';

import {
  setupTestEnvironment,
  cleanupTestEnvironment,
  createTestApp,
} from '@agent-console/server/src/__tests__/test-utils';
import { createTestContext, shutdownAppContext } from '@agent-console/server/src/app-context';
import type { AppContext } from '@agent-console/server/src/app-context';
import { createMockPtyProvider } from '@agent-console/server/src/__tests__/utils/mock-pty';
import { buildSessionsSyncMessage } from '@agent-console/server/src/websocket/app-handler';
import { serverConfig } from '@agent-console/server/src/lib/server-config';

import {
  AppServerMessageSchema,
  FileContentResponseSchema,
  FileTreeResponseSchema,
  WorkerResponseSchema,
} from '@agent-console/shared';

const ROOT = '/test/viewer-wt';
const OUTSIDE = '/test/viewer-outside';
const CAP = serverConfig.FILE_VIEWER_MAX_BYTES;
const DOTFILE = ['.', 'env'].join('');

describe('Client-Server Boundary: file viewer worker', () => {
  let ctx: AppContext;
  let sessionId: string;
  let workerId: string;
  let app: Awaited<ReturnType<typeof createTestApp>>;

  beforeEach(async () => {
    await setupTestEnvironment();

    await fs.mkdir(`${ROOT}/.git`, { recursive: true });
    await fs.mkdir(`${ROOT}/sub`, { recursive: true });
    await fs.mkdir(OUTSIDE, { recursive: true });
    await fs.writeFile(`${ROOT}/.git/HEAD`, 'ref: refs/heads/main\n');
    await fs.writeFile(`${ROOT}/sub/nested.ts`, 'export const nested = 1;\n');
    await fs.writeFile(`${ROOT}/${DOTFILE}`, 'SECRET=1\n');
    await fs.writeFile(`${ROOT}/README.md`, '# title\n');
    const binary = Buffer.alloc(64, 0x61);
    binary[10] = 0;
    await fs.writeFile(`${ROOT}/blob.bin`, binary);
    await fs.writeFile(`${ROOT}/big.txt`, Buffer.alloc(CAP + 1, 0x61));
    await fs.writeFile(`${OUTSIDE}/secret.txt`, 'TOP SECRET\n');
    await fs.symlink('README.md', `${ROOT}/link-inside`);
    await fs.symlink(`${OUTSIDE}/secret.txt`, `${ROOT}/link-outside`);

    ctx = await createTestContext({ ptyProvider: createMockPtyProvider(), assertSpawnCwdFn: async () => {} });
    app = await createTestApp(ctx);

    const owner = await ctx.userRepository.upsertByOsUid(54323, 'viewer-owner', '/home/viewer-owner');
    const created = await ctx.sessionManager.createSession(
      { type: 'quick', locationPath: ROOT, agentId: 'claude-code-builtin' },
      { createdBy: owner.id },
    );
    sessionId = created.id;

    const res = await app.request(`/api/sessions/${sessionId}/workers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'file-viewer' }),
    });
    expect(res.status).toBe(201);
    const parsed = v.parse(WorkerResponseSchema, await res.json());
    expect(parsed.worker.type).toBe('file-viewer');
    workerId = parsed.worker.id;
  });

  afterEach(async () => {
    await shutdownAppContext(ctx);
    await cleanupTestEnvironment();
  });

  const get = async (path: string) => {
    const res = await app.request(`/api/sessions/${sessionId}/workers/${workerId}/files/${path}`);
    return { status: res.status, body: JSON.parse(await res.text()) as unknown };
  };

  it('the created worker reaches the client as type file-viewer in the sessions-sync frame', async () => {
    const syncMsg = await buildSessionsSyncMessage({
      primeActiveSessionUsernames: () => ctx.sessionManager.primeActiveSessionUsernames(),
      logger: { debug: () => {}, warn: () => {}, error: () => {} },
      getAllSessions: () => ctx.sessionManager.getAllSessions(),
      getAllPausedSessions: () => ctx.sessionManager.getAllPausedSessions(),
      getWorkerActivityState: (sid, wid) => ctx.sessionManager.getWorkerActivityState(sid, wid),
    });

    const parsed = v.safeParse(AppServerMessageSchema, JSON.parse(JSON.stringify(syncMsg)));
    expect(parsed.success).toBe(true);
    if (!parsed.success || parsed.output.type !== 'sessions-sync') {
      throw new Error('sessions-sync frame did not parse');
    }
    const session = parsed.output.sessions.find((s) => s.id === sessionId);
    const worker = session?.workers.find((w) => w.id === workerId);
    expect(worker).toEqual({ id: workerId, type: 'file-viewer', name: 'File Viewer', createdAt: expect.any(String) });
    // The initial worker and Diff are still there; no viewer was added by createSession itself.
    expect(session?.workers.map((w) => w.type)).toEqual(['agent', 'git-diff', 'file-viewer']);
  });

  it('lists the working directory with dotfiles, .git and symlinks, parsed by the shared schema', async () => {
    const { status, body } = await get('tree');
    expect(status).toBe(200);
    const tree = v.parse(FileTreeResponseSchema, body);
    expect(tree.path).toBe('');
    const kinds = new Map(tree.entries.map((e) => [e.name, e.kind]));
    expect(kinds.get(DOTFILE)).toBe('file');
    expect(kinds.get('.git')).toBe('dir');
    expect(kinds.get('sub')).toBe('dir');
    expect(kinds.get('README.md')).toBe('file');
    expect(kinds.get('link-inside')).toBe('symlink');
    expect(kinds.get('link-outside')).toBe('symlink');
    expect(tree.entries.every((e) => Object.keys(e).sort().join() === 'kind,name')).toBe(true);
  });

  it('lists a subdirectory (query path) and a symlink-free .git', async () => {
    const sub = v.parse(FileTreeResponseSchema, (await get('tree?path=sub')).body);
    expect(sub).toEqual({ path: 'sub', entries: [{ name: 'nested.ts', kind: 'file' }] });
    const git = v.parse(FileTreeResponseSchema, (await get('tree?path=.git')).body);
    expect(git.entries).toEqual([{ name: 'HEAD', kind: 'file' }]);
  });

  it('reads a text file: highlighted language comes from the shared map', async () => {
    const { status, body } = await get('content?path=sub%2Fnested.ts');
    expect(status).toBe(200);
    expect(v.parse(FileContentResponseSchema, body)).toEqual({
      path: 'sub/nested.ts',
      kind: 'text',
      content: 'export const nested = 1;\n',
      size: 25,
      truncated: false,
      language: 'typescript',
    });
  });

  it('reads a dotfile, and a symlink to a file inside the working directory', async () => {
    expect(v.parse(FileContentResponseSchema, (await get(`content?path=${DOTFILE}`)).body).content).toBe('SECRET=1\n');
    expect(v.parse(FileContentResponseSchema, (await get('content?path=link-inside')).body).content).toBe('# title\n');
  });

  it('a binary file comes back as kind binary with its size and no content key', async () => {
    const { status, body } = await get('content?path=blob.bin');
    expect(status).toBe(200);
    const parsed = v.parse(FileContentResponseSchema, body);
    expect(parsed.kind).toBe('binary');
    expect(parsed.size).toBe(64);
    expect('content' in (body as object)).toBe(false);
  });

  it('a file of 1 MiB + 1 byte comes back cut to 1 MiB, truncated, with the real size', async () => {
    const { status, body } = await get('content?path=big.txt');
    expect(status).toBe(200);
    const parsed = v.parse(FileContentResponseSchema, body);
    expect(parsed.kind).toBe('text');
    expect(parsed.truncated).toBe(true);
    expect(parsed.size).toBe(CAP + 1);
    expect(parsed.content?.length).toBe(CAP);
  });

  it('a symlink that leaves the working directory is refused and its target is not in the body', async () => {
    const res = await app.request(
      `/api/sessions/${sessionId}/workers/${workerId}/files/content?path=link-outside`,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain('TOP SECRET');
  });
});
