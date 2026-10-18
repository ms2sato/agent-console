/**
 * The file viewer routes (`GET .../workers/:workerId/files/tree` and
 * `.../files/content`) over HTTP against REAL files: every row of the design
 * document's boundary table as a status code and a body, the lexical guard, the
 * access check and the worker-type check. The responses are parsed with the
 * shared wire schemas, as the client does.
 *
 * Real-fs placement: symlinks and fifos need the real filesystem, so this file
 * runs in the second (real-fs) `bun test` invocation (`package.json`) and calls
 * `assertRealFs` first. The app is the real `workers` router with a stub
 * `AppContext` (a session map): the routes' own wiring is what is under test.
 * With `AUTH_MODE` unset the routes read in-process (no OS user), which is the
 * single-user path; the shell branch of the service is covered against real
 * files in `file-viewer-service-real-fs.test.ts`.
 *
 * Measured reach (mutation, restored by hand): the route passing the spawn user
 * instead of null fails "a session whose working directory is gone is 404" (plus 2
 * tests in workers.test.ts); dropping the access check fails "403 for a non-owner
 * ... on both routes" (plus workers.test.ts's 403 test); dropping the worker-type
 * check fails "400 for a worker that is not a file-viewer worker" (plus its twin in
 * workers.test.ts); the server emitting a `size` on tree entries fails the 6 tree
 * tests that parse the shared strict schema; dropping regularOnly from the
 * in-process read fails "a fifo is 400 ... does not hang".
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { constants as fsConstants, closeSync, openSync } from 'node:fs';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import * as v from 'valibot';
import {
  FileContentResponseSchema,
  FileTreeResponseSchema,
  type AuthUser,
} from '@agent-console/shared';
import type { AppBindings, AppContext } from '../../app-context.js';
import { onApiError } from '../../lib/error-handler.js';
import { serverConfig } from '../../lib/server-config.js';
import { assertRealFs } from '../../__tests__/utils/memfs-detection.js';
import { workers } from '../workers.js';

const CAP = serverConfig.FILE_VIEWER_MAX_BYTES;
const DOTFILE = ['.', 'env'].join('');
const OWNER: AuthUser = { id: 'owner-id', username: 'owner', homeDir: '/home/owner' };
const STRANGER: AuthUser = { id: 'stranger-id', username: 'stranger', homeDir: '/home/stranger' };

interface FakeSession {
  id: string;
  locationPath: string;
  createdBy?: string;
  workers: Array<{ id: string; type: string; name: string; createdAt: string; baseCommit?: string }>;
}

let base: string;
let worktree: string;
let nonGit: string;
let fifoMade = false;
let currentUser: AuthUser = OWNER;
let sharedUserIds = new Set<string>();
const sessions = new Map<string, FakeSession>();

function buildApp(): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use('*', async (c, next) => {
    c.set('appContext', {
      sessionManager: { getSession: (id: string) => sessions.get(id) },
      userRepository: null,
      sharedAccountRegistry: { isSharedUserId: (id: string) => sharedUserIds.has(id) },
    } as unknown as AppContext);
    c.set('authUser', currentUser);
    await next();
  });
  app.onError(onApiError);
  app.route('/api/sessions', workers);
  return app;
}

const app = buildApp();
const treeUrl = (query: string, session = 'S', worker = 'W') =>
  `/api/sessions/${session}/workers/${worker}/files/tree${query}`;
const contentUrl = (query: string, session = 'S', worker = 'W') =>
  `/api/sessions/${session}/workers/${worker}/files/content${query}`;
const q = (path: string) => `?path=${encodeURIComponent(path)}`;

async function getJson(url: string) {
  const res = await app.request(url);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  await assertRealFs('workers-files-real-fs');
  if (process.env.AUTH_MODE === 'multi-user') throw new Error('this test must not run with AUTH_MODE=multi-user');

  base = await realpath(await mkdtemp(join(tmpdir(), 'file-viewer-routes-')));
  worktree = join(base, 'wt');
  nonGit = join(base, 'plain');
  const outside = join(base, 'outside');
  for (const dir of [worktree, nonGit, outside]) await mkdir(dir);
  await mkdir(join(worktree, '.git'));
  await writeFile(join(worktree, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await mkdir(join(worktree, 'sub'));
  await writeFile(join(worktree, 'sub', 'nested.txt'), 'nested\n');
  await writeFile(join(worktree, 'plain.txt'), 'hello\n');
  await writeFile(join(worktree, DOTFILE), 'SECRET=1\n');
  await writeFile(join(worktree, 'app.ts'), 'export const x = 1;\n');
  await writeFile(join(worktree, 'empty.txt'), '');
  await writeFile(join(worktree, 'exact.txt'), Buffer.alloc(CAP, 0x61));
  await writeFile(join(worktree, 'over.txt'), Buffer.alloc(CAP + 1, 0x61));
  const inWindow = Buffer.alloc(9000, 0x61);
  inWindow[8191] = 0;
  await writeFile(join(worktree, 'nul-in-window.bin'), inWindow);
  const late = Buffer.alloc(9000, 0x61);
  late[8192] = 0;
  await writeFile(join(worktree, 'nul-at-8193.txt'), late);
  await writeFile(join(nonGit, 'only.txt'), 'no git\n');
  await writeFile(join(outside, 'secret.txt'), 'TOP SECRET\n');
  await symlink('plain.txt', join(worktree, 'link-to-file'));
  await symlink('sub', join(worktree, 'link-to-dir'));
  await symlink('../outside/secret.txt', join(worktree, 'link-out-file'));
  await symlink('../outside', join(worktree, 'link-out-dir'));
  await symlink('nowhere', join(worktree, 'dangling'));
  const mk = Bun.spawn(['mkfifo', join(worktree, 'pipe')], { stdout: 'ignore', stderr: 'ignore' });
  fifoMade = (await mk.exited) === 0;

  const workersFor = (extra: FakeSession['workers'] = []): FakeSession['workers'] => [
    { id: 'W', type: 'file-viewer', name: 'File Viewer', createdAt: '2026-01-01T00:00:00Z' },
    { id: 'D', type: 'git-diff', name: 'Diff', createdAt: '2026-01-01T00:00:00Z', baseCommit: 'x' },
    ...extra,
  ];
  sessions.set('S', { id: 'S', locationPath: worktree, createdBy: OWNER.id, workers: workersFor() });
  sessions.set('NG', { id: 'NG', locationPath: nonGit, createdBy: OWNER.id, workers: workersFor() });
  sessions.set('GONE', { id: 'GONE', locationPath: join(base, 'deleted-dir'), createdBy: OWNER.id, workers: workersFor() });
  sessions.set('SHARED', { id: 'SHARED', locationPath: worktree, createdBy: 'shared-account-id', workers: workersFor() });
});

afterAll(async () => {
  if (base) await rm(base, { recursive: true });
});

function unblockFifo(path: string): void {
  try {
    closeSync(openSync(path, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK));
  } catch {
    // no reader waiting
  }
}

describe('GET .../files/tree', () => {
  it('lists the root when no path is given, parsed by the shared schema; dotfiles and .git are in it', async () => {
    const { status, body } = await getJson(treeUrl(''));
    expect(status).toBe(200);
    const parsed = v.parse(FileTreeResponseSchema, body);
    expect(parsed.path).toBe('');
    const names = parsed.entries.map((e) => e.name);
    expect(names).toContain(DOTFILE);
    expect(parsed.entries.find((e) => e.name === '.git')).toEqual({ name: '.git', kind: 'dir' });
    // directories first
    expect(parsed.entries[0].kind).toBe('dir');
  });

  it('an explicit empty path is the root as well', async () => {
    expect((await getJson(treeUrl('?path='))).body.path).toBe('');
  });

  it('lists a subdirectory and echoes its path', async () => {
    const { status, body } = await getJson(treeUrl(q('sub')));
    expect(status).toBe(200);
    expect(body).toEqual({ path: 'sub', entries: [{ name: 'nested.txt', kind: 'file' }] });
  });

  it('lists .git like any directory', async () => {
    const { body } = await getJson(treeUrl(q('.git')));
    expect(body.entries).toEqual([{ name: 'HEAD', kind: 'file' }]);
  });

  it('a directory that is not a git repository is listed like any other', async () => {
    const { status, body } = await getJson(treeUrl('', 'NG'));
    expect(status).toBe(200);
    expect(body.entries).toEqual([{ name: 'only.txt', kind: 'file' }]);
  });

  it('lists symlinks as their own kind; expanding one inside the tree lists the target, one that leaves is 400', async () => {
    const root = await getJson(treeUrl(''));
    const kinds = new Map((root.body.entries as Array<{ name: string; kind: string }>).map((e) => [e.name, e.kind]));
    expect(kinds.get('link-to-dir')).toBe('symlink');
    expect(kinds.get('link-out-dir')).toBe('symlink');

    const inside = await getJson(treeUrl(q('link-to-dir')));
    expect(inside.status).toBe(200);
    expect(inside.body.entries).toEqual([{ name: 'nested.txt', kind: 'file' }]);

    const outside = await getJson(treeUrl(q('link-out-dir')));
    expect(outside.status).toBe(400);
  });

  it('a fifo is listed as a file', async () => {
    if (!fifoMade) return;
    const { body } = await getJson(treeUrl(''));
    expect((body.entries as Array<{ name: string; kind: string }>).find((e) => e.name === 'pipe')).toEqual({
      name: 'pipe',
      kind: 'file',
    });
  });

  it('a tree request for a file is 400; a missing directory and a dangling symlink are 404', async () => {
    expect((await getJson(treeUrl(q('plain.txt')))).status).toBe(400);
    expect((await getJson(treeUrl(q('nope')))).status).toBe(404);
    expect((await getJson(treeUrl(q('dangling')))).status).toBe(404);
  });

  it.each(['../x', 'a/../b', '/etc', 'a%00b'])('rejects the unsafe path %j with 400 before touching the filesystem', async (bad) => {
    const raw = bad.includes('%') ? `?path=${bad}` : q(bad);
    expect((await getJson(treeUrl(raw))).status).toBe(400);
  });
});

describe('GET .../files/content', () => {
  const content = async (path: string, session = 'S') => getJson(contentUrl(q(path), session));

  it('text: parsed by the shared schema, language stamped from the path', async () => {
    const { status, body } = await content('app.ts');
    expect(status).toBe(200);
    expect(v.parse(FileContentResponseSchema, body)).toEqual({
      path: 'app.ts',
      kind: 'text',
      content: 'export const x = 1;\n',
      size: 20,
      truncated: false,
      language: 'typescript',
    });
  });

  it('empty file', async () => {
    const { body } = await content('empty.txt');
    expect(v.parse(FileContentResponseSchema, body)).toEqual({
      path: 'empty.txt',
      kind: 'text',
      content: '',
      size: 0,
      truncated: false,
      language: 'text',
    });
  });

  it('exactly 1 MiB is not truncated; 1 MiB + 1 byte is, with the real size', async () => {
    const exact = v.parse(FileContentResponseSchema, (await content('exact.txt')).body);
    expect(exact.content?.length).toBe(CAP);
    expect(exact.truncated).toBe(false);
    expect(exact.size).toBe(CAP);

    const over = v.parse(FileContentResponseSchema, (await content('over.txt')).body);
    expect(over.content?.length).toBe(CAP);
    expect(over.truncated).toBe(true);
    expect(over.size).toBe(CAP + 1);
  });

  it('a NUL at byte 8193 is text; a NUL within the first 8 KiB is binary without content', async () => {
    const late = v.parse(FileContentResponseSchema, (await content('nul-at-8193.txt')).body);
    expect(late.kind).toBe('text');
    const inside = v.parse(FileContentResponseSchema, (await content('nul-in-window.bin')).body);
    expect(inside.kind).toBe('binary');
    expect('content' in inside).toBe(false);
    expect(inside.size).toBe(9000);
  });

  it('a directory is 400, a missing file is 404', async () => {
    expect((await content('sub')).status).toBe(400);
    expect((await content('.git')).status).toBe(400);
    expect((await content('nope.txt')).status).toBe(404);
  });

  it('a symlink that leaves the working directory is 400 and its content is never in the body', async () => {
    for (const link of ['link-out-file', 'link-out-dir/secret.txt']) {
      const res = await app.request(contentUrl(q(link)));
      expect(res.status).toBe(400);
      expect(await res.text()).not.toContain('TOP SECRET');
    }
  });

  it('a symlink to a regular file inside the working directory opens', async () => {
    const { status, body } = await content('link-to-file');
    expect(status).toBe(200);
    expect(body.content).toBe('hello\n');
  });

  it('a dotfile and a file under .git are readable', async () => {
    expect((await content(DOTFILE)).body.content).toBe('SECRET=1\n');
    expect((await content('.git/HEAD')).body.content).toBe('ref: refs/heads/main\n');
  });

  it('a file in a non-git directory is read like any other', async () => {
    expect((await content('only.txt', 'NG')).body.content).toBe('no git\n');
  });

  it('a fifo is 400 "not a regular file" and the request does not hang', async () => {
    if (!fifoMade) return;
    const fifo = join(worktree, 'pipe');
    const attempt = app.request(contentUrl(q('pipe')));
    const outcome = await Promise.race([attempt, Bun.sleep(3_000).then(() => 'blocked' as const)]);
    if (outcome === 'blocked') {
      unblockFifo(fifo);
      await attempt;
    }
    expect(outcome).not.toBe('blocked');
    const res = outcome as Response;
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('Not a regular file');
  });

  it('requires a non-empty path', async () => {
    expect((await getJson(contentUrl(''))).status).toBe(400);
    expect((await getJson(contentUrl('?path='))).status).toBe(400);
  });

  it.each(['../x', 'a/../b', '/etc/passwd', 'a%00b'])('rejects the unsafe path %j with 400', async (bad) => {
    const raw = bad.includes('%') ? `?path=${bad}` : q(bad);
    expect((await getJson(contentUrl(raw))).status).toBe(400);
  });
});

describe('both routes: session, worker and access checks', () => {
  it('404 for an unknown session and for an unknown worker', async () => {
    expect((await getJson(treeUrl('', 'nope'))).status).toBe(404);
    expect((await getJson(contentUrl(q('plain.txt'), 'nope'))).status).toBe(404);
    expect((await getJson(treeUrl('', 'S', 'nope'))).status).toBe(404);
    expect((await getJson(contentUrl(q('plain.txt'), 'S', 'nope'))).status).toBe(404);
  });

  it('400 for a worker that is not a file-viewer worker (a git-diff worker)', async () => {
    const tree = await getJson(treeUrl('', 'S', 'D'));
    expect(tree.status).toBe(400);
    expect(tree.body.error).toContain('not a file-viewer worker');
    expect((await getJson(contentUrl(q('plain.txt'), 'S', 'D'))).status).toBe(400);
  });

  it('a session whose working directory is gone is 404 on both routes (no elevation is needed, so the read is in-process and says so)', async () => {
    // With an OS user the non-elevated runner would fail the spawn itself (500); the route passes
    // no user when `shouldElevateForUser` is false, so the service answers NotFound.
    const tree = await getJson(treeUrl('', 'GONE'));
    expect(tree.status).toBe(404);
    expect(tree.body.error).toBe('Working directory not found');
    expect((await getJson(contentUrl(q('a.txt'), 'GONE'))).status).toBe(404);
  });

  describe('multi-user mode (assertCanOperateSession)', () => {
    async function withAuthMode<T>(run: () => Promise<T>): Promise<T> {
      const original = serverConfig.AUTH_MODE;
      (serverConfig as { AUTH_MODE: string }).AUTH_MODE = 'multi-user';
      try {
        return await run();
      } finally {
        (serverConfig as { AUTH_MODE: string }).AUTH_MODE = original;
        currentUser = OWNER;
        sharedUserIds = new Set();
      }
    }

    it('403 for a non-owner on a personal session, on both routes, and no content is read', async () => {
      await withAuthMode(async () => {
        currentUser = STRANGER;
        const tree = await app.request(treeUrl(''));
        expect(tree.status).toBe(403);
        const file = await app.request(contentUrl(q(DOTFILE)));
        expect(file.status).toBe(403);
        expect(await file.text()).not.toContain('SECRET');
      });
    });

    it('the session owner is allowed', async () => {
      await withAuthMode(async () => {
        currentUser = OWNER;
        expect((await app.request(treeUrl(''))).status).toBe(200);
        expect((await app.request(contentUrl(q('plain.txt')))).status).toBe(200);
      });
    });

    it('anyone may view a shared-account session', async () => {
      await withAuthMode(async () => {
        currentUser = STRANGER;
        sharedUserIds = new Set(['shared-account-id']);
        expect((await app.request(treeUrl('', 'SHARED'))).status).toBe(200);
        expect((await app.request(contentUrl(q('plain.txt'), 'SHARED'))).status).toBe(200);
      });
    });

    it('single-user mode does not check ownership', async () => {
      currentUser = STRANGER;
      try {
        expect((await app.request(treeUrl(''))).status).toBe(200);
      } finally {
        currentUser = OWNER;
      }
    });
  });
});
