/**
 * Cross-Package Boundary Test: declared MCP servers / subagents fields
 * (epic #1636 Phase 5 PR-1, decision 3; Issue #1779).
 *
 * pre-pr-completeness.md's Q10 boundary test for this PR: a `claude-sdk`
 * definition's declared `mcpServers`/`subagents` must survive the full
 * chain -- create (minimal) -> PATCH through the real
 * `EmbeddedAgentManager.updateEmbeddedAgent` (the same manager method the
 * REST route is a thin pass-through over) -> read back through
 * `getEmbeddedAgent` -> activate a worker -> the composed `init` command's
 * stdin payload -> `JSON.stringify` (the actual stdio wire transport) ->
 * `JSON.parse` -> `EmbeddedAgentCommandSchema.safeParse` (the same schema
 * the subprocess parses with). Client rendering is PR-3, so only the wire
 * round trip's schema-parse correctness is checked here -- see PR-1's AC
 * "Integration test" section.
 *
 * Modeled on embedded-agent-identity-env-boundary.test.ts: a real
 * `AppContext` (real `SessionManager`, real `EmbeddedAgentWorkerService`,
 * real session/worker rows) with a fake `spawnAsUserFn` standing in for the
 * loop subprocess at the lowest level. Unlike that file's fake (which
 * discards stdin writes), this fake CAPTURES every stdin write into an
 * array, mirroring the `stdinWrites` pattern in
 * packages/server/src/services/__tests__/embedded-agent-worker-service.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as v from 'valibot';

import { setupTestEnvironment, cleanupTestEnvironment } from '@agent-console/server/src/__tests__/test-utils';
import { createTestContext, shutdownAppContext } from '@agent-console/server/src/app-context';
import type { AppContext } from '@agent-console/server/src/app-context';
import type {
  SpawnAsUserFn,
  SpawnAsUserOpts,
  SpawnAsUserResult,
} from '@agent-console/server/src/services/privilege-elevation';

import { EmbeddedAgentCommandSchema } from '@agent-console/shared';

/** Minimal subset of Bun's FileSink consumed by EmbeddedAgentWorkerService, capturing every write. */
interface FakeFileSink {
  write: (chunk: string | Uint8Array) => number;
  end: () => void;
  flush: () => number;
}

/** The subset of `Subprocess` the service reads while a worker stays activated. */
interface FakeSubprocess {
  pid: number;
  exited: Promise<number>;
  stdin: FakeFileSink;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  kill: () => void;
}

function makeFakeSpawn(): { fn: SpawnAsUserFn; captured: SpawnAsUserOpts[]; stdinWrites: string[] } {
  const captured: SpawnAsUserOpts[] = [];
  const stdinWrites: string[] = [];
  const stdout = new ReadableStream<Uint8Array>({ start() {} });
  const stderr = new ReadableStream<Uint8Array>({ start() {} });
  const exited = new Promise<number>(() => {
    // Never resolves -- this test never deactivates the worker.
  });
  const stdin: FakeFileSink = {
    write: (chunk) => {
      const s = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
      stdinWrites.push(s);
      return 0;
    },
    end: () => {},
    flush: () => 0,
  };
  const subprocess: FakeSubprocess = { pid: 9998, exited, stdin, stdout, stderr, kill: () => {} };
  const fn: SpawnAsUserFn = (opts) => {
    captured.push(opts);
    const result: Pick<SpawnAsUserResult, 'elevated'> & { subprocess: FakeSubprocess; stdin: FakeFileSink } = {
      subprocess,
      stdin,
      elevated: false,
    };
    return result as SpawnAsUserResult;
  };
  return { fn, captured, stdinWrites };
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
}

describe('Server-Subprocess Boundary: declared mcpServers/subagents (epic #1636 Phase 5 PR-1, decision 3, Issue #1779)', () => {
  let ctx: AppContext;
  let fake: ReturnType<typeof makeFakeSpawn>;

  beforeEach(async () => {
    await setupTestEnvironment();
    fake = makeFakeSpawn();
    ctx = await createTestContext({ spawnAsUserFn: fake.fn });
  });

  afterEach(async () => {
    await shutdownAppContext(ctx);
    await cleanupTestEnvironment();
  });

  it('a claude-sdk definition\'s declared mcpServers/subagents survive create -> PATCH -> read-back -> activation -> the serialized init command', async () => {
    const owner = await ctx.userRepository.upsertByOsUid(13579, 'owner', '/home/owner');

    // 1. Create (minimal claude-sdk arm: engine, name, provider.model only).
    const def = await ctx.embeddedAgentManager.createEmbeddedAgent(
      { engine: 'claude-sdk', name: 'Claude with MCP', provider: { model: 'claude-sonnet-5' } },
      owner.id,
    );
    expect(def.engine).toBe('claude-sdk');
    if (def.engine === 'claude-sdk') {
      expect(def.mcpServers).toBeUndefined();
      expect(def.subagents).toBeUndefined();
    }

    // 2. PATCH in declared servers/subagents through the REAL manager (the
    //    same method the REST route thinly wraps).
    const mcpServers = {
      docs: { type: 'stdio' as const, command: 'docs-mcp', args: ['--stdio'], envRef: 'docs-mcp-key' },
      remote: { type: 'http' as const, url: 'https://mcp.example.com/', headersRef: 'remote-mcp-headers' },
    };
    const subagents = {
      reviewer: { description: 'Reviews code', prompt: 'Review the diff carefully.' },
    };
    const patched = await ctx.embeddedAgentManager.updateEmbeddedAgent(def.id, {
      enabledTools: ['Task'],
      mcpServers,
      subagents,
    });
    expect(patched).not.toBeNull();

    // 3. Read back through getEmbeddedAgent and assert the declared values
    //    equal what was set.
    const reread = ctx.embeddedAgentManager.getEmbeddedAgent(def.id);
    expect(reread?.engine).toBe('claude-sdk');
    if (reread?.engine === 'claude-sdk') {
      expect(reread.mcpServers).toEqual(mcpServers);
      expect(reread.subagents).toEqual(subagents);
    }

    // 4. Create a session + worker referencing this definition, activate it.
    const session = await ctx.sessionManager.createSession(
      { type: 'quick', locationPath: '/test/quick-cwd' },
      { createdBy: owner.id },
    );
    const worker = await ctx.sessionManager.createWorker(session.id, {
      type: 'embedded-agent',
      embeddedAgentId: def.id,
    });
    expect(worker).not.toBeNull();
    await ctx.sessionManager.activateEmbeddedAgentWorker(session.id, worker!.id);
    await waitFor(() => fake.stdinWrites.length >= 1);

    // 5. Parse the FIRST captured write (the init command) as an actual
    //    stdio wire transport round trip: JSON.stringify already happened
    //    server-side, so JSON.parse + schema-parse here is the real
    //    subprocess-side boundary.
    const parsedInit: unknown = JSON.parse(fake.stdinWrites[0]);
    const result = v.safeParse(EmbeddedAgentCommandSchema, parsedInit);
    expect(result.success).toBe(true);
    if (result.success && result.output.type === 'init' && result.output.engine === 'claude-sdk') {
      expect(result.output.mcpServers).toEqual(mcpServers);
      expect(result.output.subagents).toEqual(subagents);
    }
  });

  it('regression: a claude-sdk definition with no declared mcpServers/subagents activates fine and the parsed init command omits both fields', async () => {
    const owner = await ctx.userRepository.upsertByOsUid(24680, 'owner-2', '/home/owner-2');

    const def = await ctx.embeddedAgentManager.createEmbeddedAgent(
      { engine: 'claude-sdk', name: 'Claude no MCP', provider: { model: 'claude-sonnet-5' } },
      owner.id,
    );

    const session = await ctx.sessionManager.createSession(
      { type: 'quick', locationPath: '/test/quick-cwd-2' },
      { createdBy: owner.id },
    );
    const worker = await ctx.sessionManager.createWorker(session.id, {
      type: 'embedded-agent',
      embeddedAgentId: def.id,
    });
    expect(worker).not.toBeNull();
    await ctx.sessionManager.activateEmbeddedAgentWorker(session.id, worker!.id);
    await waitFor(() => fake.stdinWrites.length >= 1);

    const parsedInit: unknown = JSON.parse(fake.stdinWrites[0]);
    const result = v.safeParse(EmbeddedAgentCommandSchema, parsedInit);
    expect(result.success).toBe(true);
    if (result.success && result.output.type === 'init' && result.output.engine === 'claude-sdk') {
      expect(result.output.mcpServers).toBeUndefined();
      expect(result.output.subagents).toBeUndefined();
    }
    expect('mcpServers' in (parsedInit as Record<string, unknown>)).toBe(false);
    expect('subagents' in (parsedInit as Record<string, unknown>)).toBe(false);
  });
});
