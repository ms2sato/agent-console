/**
 * Client-Server Boundary Test: EmbeddedAgentDefinition.instructions (Issue #1072, CLAUDE.md Q10)
 *
 * Regression guard for the wire boundary of the `instructions?: string[]`
 * field added to `EmbeddedAgentDefinition`. valibot's default object parse
 * silently strips unknown fields, so an `EmbeddedAgentDefinitionSchema`
 * missing an `instructions` entry would drop the field from the
 * `embedded-agent-created` / `embedded-agent-updated` app-sync messages with
 * no compile / runtime error until manual QA notices the gap. Neither server
 * unit tests (which never cross the schema boundary) nor frontend mock-factory
 * tests (which inject pre-built definition objects) can catch that.
 *
 * This boundary test exercises the real chain:
 *   ctx.embeddedAgentManager.createEmbeddedAgent({ instructions: [...] })
 *     -> the same definition object the manager broadcasts via
 *        onEmbeddedAgentCreated({ type: 'embedded-agent-created', embeddedAgent })
 *     -> JSON serialize (wire transmission simulation)
 *     -> AppServerMessageSchema.safeParse (the same parser the client uses)
 *   assert `instructions` survives end-to-end, including the empty-array shape.
 *
 * Removing the `instructions` entry from `EmbeddedAgentDefinitionSchema` in
 * packages/shared/src/schemas/embedded-agent.ts causes this test to fail
 * (the field is stripped by safeParse).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as v from 'valibot';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  setupTestEnvironment,
  cleanupTestEnvironment,
} from '@agent-console/server/src/__tests__/test-utils';
import { createTestContext, shutdownAppContext } from '@agent-console/server/src/app-context';
import type { AppContext } from '@agent-console/server/src/app-context';

import { AppServerMessageSchema, type EmbeddedAgentEvent } from '@agent-console/shared';

import { runLoop, type LoopFactories, type LoopIO, type McpClientLike } from '@agent-console/embedded-agent/src/main';
import { loadInstructions } from '@agent-console/embedded-agent/src/system-prompt';
import type {
  ProviderAdapter,
  ProviderEvent,
  ProviderRunRequest,
  ToolDefinition,
} from '@agent-console/embedded-agent/src/providers/types';
import type { ToolCallOutcome } from '@agent-console/embedded-agent/src/mcp';
import type { Engine } from '@agent-console/embedded-agent/src/engine-types';
import type { SdkEngineDeps } from '@agent-console/embedded-agent/src/sdk-engine';

describe('Client-Server Boundary: EmbeddedAgentDefinition.instructions', () => {
  let ctx: AppContext;

  beforeEach(async () => {
    await setupTestEnvironment();
    ctx = await createTestContext();
  });

  afterEach(async () => {
    await shutdownAppContext(ctx);
    await cleanupTestEnvironment();
  });

  it('survives the server -> JSON wire -> AppServerMessageSchema.safeParse round-trip', async () => {
    const owner = await ctx.userRepository.upsertByOsUid(54321, 'owner', '/home/owner');

    const def = await ctx.embeddedAgentManager.createEmbeddedAgent(
      {
        name: 'Ollama qwen3',
        provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b' },
        instructions: ['docs/local-note.md', 'CONTRIBUTING.md'],
      },
      owner.id,
    );
    expect(def.instructions).toEqual(['docs/local-note.md', 'CONTRIBUTING.md']);

    const wirePayload = JSON.parse(
      JSON.stringify({ type: 'embedded-agent-created', embeddedAgent: def }),
    );

    const parsed = v.safeParse(AppServerMessageSchema, wirePayload);

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error(
        `safeParse failed unexpectedly: ${JSON.stringify(parsed.issues.map((i) => i.message))}`,
      );
    }
    if (parsed.output.type !== 'embedded-agent-created') {
      throw new Error(`Expected embedded-agent-created, got: ${parsed.output.type}`);
    }

    // The crucial assertion: `instructions` must survive the schema parser,
    // not just be undefined-and-therefore-absent.
    expect('instructions' in parsed.output.embeddedAgent).toBe(true);
    expect(parsed.output.embeddedAgent.instructions).toEqual([
      'docs/local-note.md',
      'CONTRIBUTING.md',
    ]);
  });

  it('an explicit empty instructions array survives the round-trip (not collapsed to undefined)', async () => {
    const owner = await ctx.userRepository.upsertByOsUid(54322, 'owner2', '/home/owner2');

    const def = await ctx.embeddedAgentManager.createEmbeddedAgent(
      {
        name: 'No Instructions',
        provider: { baseUrl: 'http://localhost:11434/v1', model: 'llama3' },
        instructions: [],
      },
      owner.id,
    );
    expect(def.instructions).toEqual([]);

    const wirePayload = JSON.parse(
      JSON.stringify({ type: 'embedded-agent-updated', embeddedAgent: def }),
    );

    const parsed = v.safeParse(AppServerMessageSchema, wirePayload);

    expect(parsed.success).toBe(true);
    if (!parsed.success || parsed.output.type !== 'embedded-agent-updated') {
      throw new Error('expected a successful embedded-agent-updated parse');
    }
    expect(parsed.output.embeddedAgent.instructions).toEqual([]);
  });

  it('absent instructions stays undefined through the round-trip (no spurious default)', async () => {
    const owner = await ctx.userRepository.upsertByOsUid(54323, 'owner3', '/home/owner3');

    const def = await ctx.embeddedAgentManager.createEmbeddedAgent(
      {
        name: 'Default',
        provider: { baseUrl: 'http://localhost:11434/v1', model: 'llama3' },
      },
      owner.id,
    );
    expect(def.instructions).toBeUndefined();

    const wirePayload = JSON.parse(
      JSON.stringify({ type: 'embedded-agent-created', embeddedAgent: def }),
    );

    const parsed = v.safeParse(AppServerMessageSchema, wirePayload);

    expect(parsed.success).toBe(true);
    if (!parsed.success || parsed.output.type !== 'embedded-agent-created') {
      throw new Error('expected a successful embedded-agent-created parse');
    }
    expect(parsed.output.embeddedAgent.instructions).toBeUndefined();
  });
});

/**
 * Pipeline Connectivity: .claude/rules layer reaches BOTH engines'
 * subprocess entry point (Issue #1343 Phase A, R2)
 *
 * The wire-boundary tests above cover `EmbeddedAgentDefinition.instructions`
 * specifically. This block is a different boundary: the SUBPROCESS side --
 * `packages/embedded-agent/src/main.ts`'s `runLoop`, the actual entry point
 * that becomes the embedded-agent subprocess in production -- driven
 * directly with the REAL `loadInstructions` against a real scratch git repo
 * containing an unscoped `.claude/rules/*.md` file, on BOTH engines. A unit
 * test on `system-prompt.ts` alone cannot show this reaches the composed
 * system prompt THROUGH `runLoop`'s dispatch on both `openai-api` and
 * `claude-sdk` init arms; that connectivity is what this test exercises
 * (1-2 representative cases, per testing.md's Integration-test scope --
 * exhaustive rules-layer coverage is system-prompt.test.ts's job).
 */
describe('Subprocess system-prompt composition: .claude/rules layer reaches both engines', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    // Real-fs cleanup via spawn, not node:fs/promises -- see the helper's own
    // comment for why (mirrors notification-boundary.test.ts's identical
    // `Bun.spawnSync(['rm', '-rf', ...])` pattern in this same package).
    for (const d of tempDirs.splice(0)) Bun.spawnSync(['rm', '-rf', d]);
  });

  /**
   * This package's process gets `node:fs`/`node:fs/promises` permanently
   * swapped for an in-memory `memfs` volume the moment ANY file in the same
   * `bun test` run imports `@agent-console/server/src/__tests__/test-utils`
   * (`mock.module` calls execute once, at that module's first import, and
   * are process-global for the rest of the run -- `testing.md`'s "Module-Level
   * Mocking" anti-pattern, mechanized here by `mock-fs-helper.ts`). This file
   * imports that module, so `system-prompt.ts`'s OWN `node:fs/promises` calls
   * -- not just this test's -- resolve against the SAME virtual volume, not
   * the real OS filesystem. But `system-prompt.ts` splits its filesystem
   * access: `findGitRoot`/`loadRulesLayer` use `node:fs/promises`
   * (`stat`/`readdir`, for directory structure and listings) while file
   * CONTENT is read via `Bun.file(...).text()`, which bypasses the
   * `node:fs` module registry entirely and reads the REAL disk. The two must
   * therefore be written to agree: the `.git` marker and the rules
   * directory's file LISTING go through `node:fs/promises` (memfs, for
   * `stat`/`readdir` to see); the rule file's actual CONTENT is written a
   * second time via `Bun.write` (real disk, for `Bun.file` to read). Skipping
   * either write makes the loader see a name with no content, or a git root
   * with nothing readable inside it.
   */
  async function makeScratchRepoWithUnscopedRule(): Promise<string> {
    const dir = join(tmpdir(), `embedded-agent-rules-boundary-${randomUUID()}`);
    tempDirs.push(dir);
    await mkdir(join(dir, '.git'), { recursive: true }); // memfs: git-root detection
    await mkdir(join(dir, '.claude', 'rules'), { recursive: true }); // memfs: readdir listing
    const ruleFile = join(dir, '.claude', 'rules', 'unscoped.md');
    await writeFile(ruleFile, 'BOUNDARY_RULE_MARKER'); // memfs: so readdir() sees the filename
    await Bun.write(ruleFile, 'BOUNDARY_RULE_MARKER'); // real disk: so Bun.file().text() finds content
    return dir;
  }

  class StubMcpClient implements McpClientLike {
    async connect(): Promise<void> {}
    async listTools(): Promise<ToolDefinition[]> {
      return [];
    }
    async callTool(): Promise<ToolCallOutcome> {
      return { ok: true, result: 'ok' };
    }
  }

  class CapturingAdapter implements ProviderAdapter {
    readonly capturedMessages: ProviderRunRequest['messages'][] = [];
    async *run(req: ProviderRunRequest): AsyncIterable<ProviderEvent> {
      this.capturedMessages.push(req.messages);
      yield { type: 'text-delta', text: 'hi' };
      yield { type: 'done', finishReason: 'stop' };
    }
  }

  class NoopEngine implements Engine {
    async runTurn(): Promise<void> {}
    cancel(): void {}
    setAutoCompaction(): void {}
  }

  function makeIo(lines: string[]): LoopIO {
    return {
      async *readCommands() {
        for (const line of lines) {
          await new Promise((resolve) => setTimeout(resolve, 0));
          yield line;
        }
      },
      writeEvent: () => {},
      logError: () => {},
    };
  }

  it('an unscoped .claude/rules/*.md file reaches the openai-api engine subprocess systemPrompt', async () => {
    const dir = await makeScratchRepoWithUnscopedRule();
    const adapter = new CapturingAdapter();
    const factories: LoopFactories = {
      createMcpClient: () => new StubMcpClient(),
      createAdapter: () => adapter,
      loadInstructions,
      loadCompactionPrompt: async () => ({ content: 'STUB', origin: 'bundled-default' }),
      createSdkEngine: () => new NoopEngine(),
      probeSdkSession: async () => 'found',
    };
    const io = makeIo([
      JSON.stringify({
        v: 1,
        type: 'init',
        compaction: { auto: false },
        engine: 'openai-api',
        mcp: { baseUrl: 'http://mcp/local', token: 'tok' },
        provider: { baseUrl: 'http://provider/v1', model: 'm' },
        context: { sessionId: 's', workerId: 'w', cwd: dir },
        maxToolIterations: 5,
      }),
      JSON.stringify({ v: 1, type: 'user-message', id: 'u1', text: 'hi' }),
      JSON.stringify({ v: 1, type: 'shutdown' }),
    ]);

    expect(await runLoop(io, factories)).toBe(0);
    const systemMessage = adapter.capturedMessages[0]?.find((m) => m.role === 'system');
    expect(systemMessage && 'content' in systemMessage ? systemMessage.content : undefined).toContain(
      'BOUNDARY_RULE_MARKER',
    );
  });

  it('an unscoped .claude/rules/*.md file reaches the claude-sdk engine subprocess systemPromptAppend', async () => {
    const dir = await makeScratchRepoWithUnscopedRule();
    let capturedDeps: SdkEngineDeps | undefined;
    const factories: LoopFactories = {
      createMcpClient: () => new StubMcpClient(),
      createAdapter: () => new CapturingAdapter(),
      loadInstructions,
      loadCompactionPrompt: async () => ({ content: 'STUB', origin: 'bundled-default' }),
      createSdkEngine: (deps) => {
        capturedDeps = deps;
        return new NoopEngine();
      },
      probeSdkSession: async () => 'found',
    };
    const io = makeIo([
      JSON.stringify({
        v: 1,
        type: 'init',
        compaction: { auto: false },
        engine: 'claude-sdk',
        mcp: { baseUrl: 'http://mcp/local', token: 'tok' },
        provider: { model: 'claude-sonnet-5' },
        context: { sessionId: 's', workerId: 'w', cwd: dir },
        maxToolIterations: 5,
      }),
    ]);

    expect(await runLoop(io, factories)).toBe(0);
    expect(capturedDeps?.systemPromptAppend).toContain('BOUNDARY_RULE_MARKER');
  });
});

/**
 * Pipeline Connectivity: scoped-rule lazy activation reaches the openai-api
 * engine's builtin tool call (Issue #1343 Phase B, R1-R3)
 *
 * Same subprocess-entry-point boundary as the block above, but exercising the
 * LAZY half of the rules layer: a scoped rule (`paths:`/`globs:` frontmatter)
 * is never in the system prompt -- it only activates when a real builtin tool
 * call's path argument matches. Driven through `runLoop` end-to-end (real
 * `loadInstructions`, real `RuleActivator`, real `CompositeToolExecutor`),
 * not a unit test on `rule-activation.ts` alone, per this file's own
 * Pipeline Connectivity scope note above (1-2 representative cases;
 * exhaustive match-table coverage is rule-activation.test.ts's job).
 */
describe('Subprocess tool-call composition: scoped .claude/rules activation reaches the openai-api engine', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const d of tempDirs.splice(0)) Bun.spawnSync(['rm', '-rf', d]);
  });

  /**
   * Same memfs/real-disk split as `makeScratchRepoWithUnscopedRule` above --
   * `node:fs/promises` (readdir/stat/realpath, used by `findGitRoot`,
   * `loadRulesLayer`'s directory listing, and `resolveConfinedPath`'s
   * confinement checks) resolves against the in-memory `memfs` volume, while
   * FILE CONTENT is read via `Bun.file(...).text()` (both the rule file's
   * content, read by `RuleActivator.activate`, and the target file's content,
   * read by the builtin `Read` tool), which bypasses `node:fs` and reads the
   * real disk. Every file below is therefore written twice.
   */
  async function makeScratchRepoWithScopedRule(): Promise<{ dir: string; matchingFile: string; nonMatchingFile: string }> {
    const dir = join(tmpdir(), `embedded-agent-rules-boundary-scoped-${randomUUID()}`);
    tempDirs.push(dir);
    await mkdir(join(dir, '.git'), { recursive: true });
    await mkdir(join(dir, '.claude', 'rules'), { recursive: true });
    await mkdir(join(dir, 'src'), { recursive: true });

    const ruleFile = join(dir, '.claude', 'rules', 'scoped.md');
    const ruleContent = '---\npaths:\n  - "src/**"\n---\n\nSCOPED_ACTIVATION_MARKER';
    await writeFile(ruleFile, ruleContent);
    await Bun.write(ruleFile, ruleContent);

    const matchingFile = join(dir, 'src', 'x.ts');
    await writeFile(matchingFile, 'export const x = 1;');
    await Bun.write(matchingFile, 'export const x = 1;');

    const nonMatchingFile = join(dir, 'README.md');
    await writeFile(nonMatchingFile, 'readme content');
    await Bun.write(nonMatchingFile, 'readme content');

    return { dir, matchingFile, nonMatchingFile };
  }

  class StubMcpClient implements McpClientLike {
    async connect(): Promise<void> {}
    async listTools(): Promise<ToolDefinition[]> {
      return [];
    }
    async callTool(): Promise<ToolCallOutcome> {
      return { ok: true, result: 'ok' };
    }
  }

  class ReadThenDoneAdapter implements ProviderAdapter {
    private calls = 0;
    constructor(private readonly path: string) {}
    async *run(): AsyncIterable<ProviderEvent> {
      this.calls += 1;
      if (this.calls === 1) {
        yield { type: 'tool-call', callId: 'c1', name: 'Read', argsJson: JSON.stringify({ path: this.path }) };
        yield { type: 'done', finishReason: 'tool_calls' };
      } else {
        yield { type: 'text-delta', text: 'done' };
        yield { type: 'done', finishReason: 'stop' };
      }
    }
  }

  class NoopEngine implements Engine {
    async runTurn(): Promise<void> {}
    cancel(): void {}
    setAutoCompaction(): void {}
  }

  interface Captured {
    io: LoopIO;
    events: EmbeddedAgentEvent[];
  }

  // Read does real fs work (genuinely async, not a same-tick microtask); the
  // drain gap and dropped `shutdown` mirror this repo's own established
  // pattern for driving a real builtin tool call through `runLoop` (see
  // main.test.ts's `makeIoWithToolDrainGap`, same rationale).
  function makeIoWithToolDrainGap(lines: string[]): Captured {
    const events: EmbeddedAgentEvent[] = [];
    const io: LoopIO = {
      async *readCommands() {
        for (const line of lines) {
          await new Promise((resolve) => setTimeout(resolve, 0));
          yield line;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      },
      writeEvent: (event) => events.push(event),
      logError: () => {},
    };
    return { io, events };
  }

  function makeFactories(adapter: ProviderAdapter): LoopFactories {
    return {
      createMcpClient: () => new StubMcpClient(),
      createAdapter: () => adapter,
      loadInstructions,
      loadCompactionPrompt: async () => ({ content: 'STUB', origin: 'bundled-default' }),
      createSdkEngine: () => new NoopEngine(),
      probeSdkSession: async () => 'found',
    };
  }

  it('activates a matching scoped rule on a real Read call, appending its block to the tool-result event', async () => {
    const { dir, matchingFile } = await makeScratchRepoWithScopedRule();
    const adapter = new ReadThenDoneAdapter(matchingFile);
    const { io, events } = makeIoWithToolDrainGap([
      JSON.stringify({
        v: 1,
        type: 'init',
        compaction: { auto: false },
        engine: 'openai-api',
        mcp: { baseUrl: 'http://mcp/local', token: 'tok' },
        provider: { baseUrl: 'http://provider/v1', model: 'm' },
        context: { sessionId: 's', workerId: 'w', cwd: dir },
        maxToolIterations: 5,
      }),
      JSON.stringify({ v: 1, type: 'user-message', id: 'u1', text: 'read it' }),
    ]);

    expect(await runLoop(io, makeFactories(adapter))).toBe(0);

    const toolResult = events.find((e) => e.type === 'tool-result');
    expect(toolResult).toMatchObject({ ok: true });
    if (toolResult?.type === 'tool-result') {
      expect(toolResult.result).toContain('[rule activated: scoped.md]');
      expect(toolResult.result).toContain('SCOPED_ACTIVATION_MARKER');
    }
  });

  it('a non-matching path produces no activation block', async () => {
    const { dir, nonMatchingFile } = await makeScratchRepoWithScopedRule();
    const adapter = new ReadThenDoneAdapter(nonMatchingFile);
    const { io, events } = makeIoWithToolDrainGap([
      JSON.stringify({
        v: 1,
        type: 'init',
        compaction: { auto: false },
        engine: 'openai-api',
        mcp: { baseUrl: 'http://mcp/local', token: 'tok' },
        provider: { baseUrl: 'http://provider/v1', model: 'm' },
        context: { sessionId: 's', workerId: 'w', cwd: dir },
        maxToolIterations: 5,
      }),
      JSON.stringify({ v: 1, type: 'user-message', id: 'u1', text: 'read it' }),
    ]);

    expect(await runLoop(io, makeFactories(adapter))).toBe(0);

    const toolResult = events.find((e) => e.type === 'tool-result');
    expect(toolResult).toMatchObject({ ok: true });
    if (toolResult?.type === 'tool-result') {
      expect(toolResult.result).not.toContain('[rule activated:');
      expect(toolResult.result).not.toContain('SCOPED_ACTIVATION_MARKER');
    }
  });
});
