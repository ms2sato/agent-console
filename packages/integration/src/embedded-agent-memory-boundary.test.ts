/**
 * Client-Server Boundary Test: memory layer's `init.context.memoryDir`
 * (epic #1636 Phase 2, Issue #1691).
 *
 * Exercises the REAL chain end to end for a quick-session embedded-agent
 * worker's first activation:
 *
 *   real message delivery (SessionManager.sendMessage's embedded-agent
 *   branch, activate-on-delivery)
 *     -> real EmbeddedAgentWorkerService.activate
 *     -> real `prepareMemoryDir` (packages/server/src/lib/memory-dir.ts):
 *        resolves the quick-session cwd-slug via `realpath`, creates the
 *        directory, and verifies its mode -- on the TEST PROCESS'S
 *        filesystem, which is memfs under this suite (`setupTestEnvironment`
 *        installs it, packages/server/src/__tests__/test-utils.ts), not the
 *        real disk. The only real-filesystem assertions in this PR are
 *        `memory-dir.test.ts` run alone.
 *     -> the subprocess (faked at the lowest level, spawnAsUserFn) receives
 *        an `init` command whose `context.memoryDir` names that directory
 *
 * Per pre-pr-completeness.md Q10, this is the integration test for the
 * `memoryDir?: string` field added to `EmbeddedAgentInitCommandBase.context`
 * (`packages/shared/src/types/embedded-agent.ts`) and its matching
 * `v.optional(v.string())` entry in `EmbeddedAgentCommandSchema`
 * (`packages/shared/src/schemas/embedded-agent.ts`, `v.strictObject`). A
 * unit test that injects `memoryDir` into a fixture bypasses the parse path
 * (`v.safeParse(EmbeddedAgentCommandSchema, ...)` below) and does not
 * satisfy this step -- only a real init frame produced by the real service
 * and validated against the real schema does.
 *
 * NOTE: packages/integration uses a FLAT sibling test layout (no __tests__/).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as v from 'valibot';
import { realpath, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import {
  setupTestEnvironment,
  cleanupTestEnvironment,
} from '@agent-console/server/src/__tests__/test-utils';
import { createTestContext, shutdownAppContext } from '@agent-console/server/src/app-context';
import type { AppContext } from '@agent-console/server/src/app-context';
import type { SpawnAsUserFn, SpawnAsUserOpts, SpawnAsUserResult } from '@agent-console/server/src/services/privilege-elevation';
import { computeQuickCwdSlug } from '@agent-console/server/src/lib/session-data-path';

import { EmbeddedAgentCommandSchema } from '@agent-console/shared';

/** Minimal subset of Bun's FileSink consumed by EmbeddedAgentWorkerService. */
interface FakeFileSink {
  write: (chunk: string | Uint8Array) => number;
  end: () => void;
  flush: () => number;
}

function makeFakeSpawn(): {
  fn: SpawnAsUserFn;
  captured: SpawnAsUserOpts[];
  stdinWrites: string[];
} {
  const captured: SpawnAsUserOpts[] = [];
  const stdinWrites: string[] = [];
  const stdout = new ReadableStream<Uint8Array>({ start() {} });
  const stderr = new ReadableStream<Uint8Array>({ start() {} });
  const exited = new Promise<number>(() => {
    // Never resolves -- this test never deactivates the worker.
  });
  const stdin: FakeFileSink = {
    write: (chunk) => {
      stdinWrites.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
      return 0;
    },
    end: () => {},
    flush: () => 0,
  };
  const subprocess = { pid: 9998, exited, stdin, stdout, stderr, kill: () => {} };
  const fn: SpawnAsUserFn = (opts) => {
    captured.push(opts);
    return { subprocess, stdin, elevated: false } as unknown as SpawnAsUserResult;
  };
  return { fn, captured, stdinWrites };
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
}

describe('Client-Server Boundary: embedded-agent memory layer init.context.memoryDir (Issue #1691)', () => {
  let ctx: AppContext;
  let fake: ReturnType<typeof makeFakeSpawn>;
  let realCwd: string;

  beforeEach(async () => {
    await setupTestEnvironment();
    fake = makeFakeSpawn();
    ctx = await createTestContext({ spawnAsUserFn: fake.fn });
    // A real (memfs-virtual, under this test env's fs mock), existing
    // directory: `resolveMemoryDirPath`'s quick-session branch calls
    // `realpath` on the session's `locationPath`, and this test asserts
    // against that realpath'd value directly rather than relying on the
    // ENOENT fallback path (already covered by memory-dir.test.ts).
    const scratch = `/test/quick-cwd-${randomUUID()}`;
    await mkdir(scratch, { recursive: true });
    realCwd = await realpath(scratch);
  });

  afterEach(async () => {
    await shutdownAppContext(ctx);
    await cleanupTestEnvironment();
  });

  it('a quick-session worker activation composes init.context.memoryDir from the real resolver, and the directory exists with mode 0700 at that moment', async () => {
    const owner = await ctx.userRepository.upsertByOsUid(13579, 'owner', '/home/owner');

    const definition = await ctx.embeddedAgentManager.createEmbeddedAgent(
      { engine: 'openai-api', name: 'Local model', provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b' } },
      owner.id,
    );
    const session = await ctx.sessionManager.createSession(
      { type: 'quick', locationPath: realCwd },
      { createdBy: owner.id },
    );
    const worker = await ctx.sessionManager.createWorker(session.id, {
      type: 'embedded-agent',
      embeddedAgentId: definition.id,
    });
    expect(worker).not.toBeNull();
    const workerId = worker!.id;

    await ctx.sessionManager.sendMessage(session.id, null, workerId, 'hello');

    await waitFor(() => fake.stdinWrites.length >= 1);
    const initCommand = JSON.parse(fake.stdinWrites[0]);
    expect(initCommand.type).toBe('init');

    const resolver = ctx.sessionManager.getPathResolverForSessionId(session.id);
    expect(resolver).not.toBeNull();
    const expectedCwdSlug = computeQuickCwdSlug(realCwd);
    const expectedMemoryDir = resolver!.getMemoryDir(definition.id, {
      kind: 'quick',
      cwdSlug: expectedCwdSlug,
    });

    expect(initCommand.context.memoryDir).toBe(expectedMemoryDir);

    // Q10 parse-path closure: the REAL subprocess-boundary schema accepts
    // the real init frame with `memoryDir` present. A fixture that injects
    // `memoryDir` directly bypasses this parse and would not catch a
    // forgotten schema entry (the #1554 blast-radius pre-pr-completeness.md
    // Q10 describes).
    const parsed = v.safeParse(EmbeddedAgentCommandSchema, initCommand);
    expect(parsed.success).toBe(true);

    // The directory must exist on the test process's filesystem (memfs
    // under this suite -- see the header), with the single-user contract's
    // mode, at the moment the init frame was composed -- not merely a path
    // string that happens to match. The wire pin above (real service -> real
    // init frame -> real strictObject parse) is the Q10 evidence; this is
    // the activation-time existence/mode contract, not a real-disk claim.
    const { lstat } = await import('node:fs/promises');
    const st = await lstat(expectedMemoryDir);
    expect(st.isDirectory()).toBe(true);
    expect(st.mode & 0o7777).toBe(0o700);
  });
});
