import { describe, it, expect } from 'bun:test';
import { join } from 'node:path';
import type { EmbeddedAgentEvent } from '@agent-console/shared';
import {
  runLoop,
  type LoopFactories,
  type LoopIO,
  type McpClientLike,
} from '../main.js';
import type {
  ProviderAdapter,
  ProviderEvent,
  ProviderRunRequest,
  ToolDefinition,
} from '../providers/types.js';
import type { ToolCallOutcome } from '../mcp.js';

const mainPath = join(import.meta.dir, '..', 'main.ts');

const initCommand = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    v: 1,
    type: 'init',
    mcp: { baseUrl: 'http://mcp/local', token: 'tok' },
    provider: { baseUrl: 'http://provider/v1', model: 'm' },
    context: { sessionId: 's', workerId: 'w', cwd: '/tmp' },
    maxToolIterations: 5,
    ...overrides,
  });

class StubAdapter implements ProviderAdapter {
  async *run(_req: ProviderRunRequest): AsyncIterable<ProviderEvent> {
    yield { type: 'text-delta', text: 'hi' };
    yield { type: 'done', finishReason: 'stop' };
  }
}

/** Captures every ProviderRunRequest.tools it was invoked with, for asserting
 * what CompositeToolExecutor merged into the tools list at the process
 * boundary (distinct from the narrower resolveEnabledBuiltinTools unit test
 * in tools/__tests__/index.test.ts). */
class CapturingAdapter implements ProviderAdapter {
  readonly capturedToolsCalls: ProviderRunRequest['tools'][] = [];
  async *run(req: ProviderRunRequest): AsyncIterable<ProviderEvent> {
    this.capturedToolsCalls.push(req.tools);
    yield { type: 'text-delta', text: 'hi' };
    yield { type: 'done', finishReason: 'stop' };
  }
}

class StubMcpClient implements McpClientLike {
  constructor(private readonly onConnect?: () => Promise<void>) {}
  async connect(): Promise<void> {
    if (this.onConnect) await this.onConnect();
  }
  async listTools(): Promise<ToolDefinition[]> {
    return [];
  }
  async callTool(): Promise<ToolCallOutcome> {
    return { ok: true, result: 'ok' };
  }
}

interface Captured {
  io: LoopIO;
  events: EmbeddedAgentEvent[];
  errors: string[];
}

function makeIo(lines: string[]): Captured {
  const events: EmbeddedAgentEvent[] = [];
  const errors: string[] = [];
  const io: LoopIO = {
    async *readCommands() {
      for (const line of lines) yield line;
    },
    writeEvent: (event) => events.push(event),
    logError: (message) => errors.push(message),
  };
  return { io, events, errors };
}

function makeFactories(overrides: Partial<LoopFactories> = {}): LoopFactories {
  return {
    createMcpClient: () => new StubMcpClient(),
    createAdapter: () => new StubAdapter(),
    readAgentsMd: async () => null,
    ...overrides,
  };
}

describe('runLoop — protocol enforcement', () => {
  it('exits 2 when the first message is not an init', async () => {
    const { io } = makeIo([JSON.stringify({ v: 1, type: 'user-message', id: 'x', text: 'hi' })]);
    expect(await runLoop(io, makeFactories())).toBe(2);
  });

  it('exits 2 on malformed JSON', async () => {
    const { io } = makeIo(['not json']);
    expect(await runLoop(io, makeFactories())).toBe(2);
  });

  it('exits 2 when the first init fails schema validation', async () => {
    const { io } = makeIo([JSON.stringify({ v: 1, type: 'init' })]);
    expect(await runLoop(io, makeFactories())).toBe(2);
  });

  it('exits 2 when a known command after init fails schema validation', async () => {
    const { io, events } = makeIo([
      initCommand(),
      JSON.stringify({ v: 1, type: 'user-message' }), // missing id/text
    ]);
    expect(await runLoop(io, makeFactories())).toBe(2);
    expect(events.some((e) => e.type === 'ready')).toBe(true);
  });

  it('ignores an unknown command type after init and continues', async () => {
    const { io, errors } = makeIo([
      initCommand(),
      JSON.stringify({ v: 1, type: 'future-thing' }),
      JSON.stringify({ v: 1, type: 'shutdown' }),
    ]);
    expect(await runLoop(io, makeFactories())).toBe(0);
    expect(errors.some((e) => e.includes('unknown type'))).toBe(true);
  });
});

describe('runLoop — lifecycle', () => {
  it('emits ready after init and exits 0 on shutdown', async () => {
    const { io, events } = makeIo([initCommand(), JSON.stringify({ v: 1, type: 'shutdown' })]);
    expect(await runLoop(io, makeFactories())).toBe(0);
    expect(events[0]).toEqual({ v: 1, type: 'ready' });
  });

  it('exits 0 on stdin EOF (no shutdown command)', async () => {
    const { io } = makeIo([initCommand()]);
    expect(await runLoop(io, makeFactories())).toBe(0);
  });

  it('runs a turn for a user-message and emits an assistant-message', async () => {
    const { io, events } = makeIo([
      initCommand(),
      JSON.stringify({ v: 1, type: 'user-message', id: 'u1', text: 'hello' }),
      JSON.stringify({ v: 1, type: 'shutdown' }),
    ]);
    expect(await runLoop(io, makeFactories())).toBe(0);
    const assistant = events.find((e) => e.type === 'assistant-message');
    expect(assistant).toMatchObject({ turnId: 'u1', text: 'hi' });
  });

  it('emits a fatal event and exits 1 when MCP connection fails', async () => {
    const { io, events } = makeIo([initCommand()]);
    const factories = makeFactories({
      createMcpClient: () =>
        new StubMcpClient(async () => {
          throw new Error('connection refused');
        }),
    });
    expect(await runLoop(io, factories)).toBe(1);
    expect(events.some((e) => e.type === 'fatal')).toBe(true);
  });
});

describe('runLoop — builtin tool merging (enabledTools)', () => {
  it('merges the default builtin tools (Read/Glob/Grep) with MCP tools when enabledTools is absent', async () => {
    const adapter = new CapturingAdapter();
    const { io } = makeIo([
      initCommand(),
      JSON.stringify({ v: 1, type: 'user-message', id: 'u1', text: 'hello' }),
      JSON.stringify({ v: 1, type: 'shutdown' }),
    ]);
    const factories = makeFactories({ createAdapter: () => adapter });

    expect(await runLoop(io, factories)).toBe(0);
    expect(adapter.capturedToolsCalls).toHaveLength(1);
    const toolNames = adapter.capturedToolsCalls[0].map((t) => t.name).sort();
    expect(toolNames).toEqual(['Glob', 'Grep', 'Read']);
  });

  it('passes ONLY the MCP tools (zero builtins) when enabledTools is an explicit empty array', async () => {
    const adapter = new CapturingAdapter();
    const { io } = makeIo([
      initCommand({ enabledTools: [] }),
      JSON.stringify({ v: 1, type: 'user-message', id: 'u1', text: 'hello' }),
      JSON.stringify({ v: 1, type: 'shutdown' }),
    ]);
    class McpWithOneTool extends StubMcpClient {
      async listTools() {
        return [{ name: 'close_session', description: 'closes', parameters: {} }];
      }
    }
    const factories = makeFactories({
      createAdapter: () => adapter,
      createMcpClient: () => new McpWithOneTool(),
    });

    expect(await runLoop(io, factories)).toBe(0);
    expect(adapter.capturedToolsCalls).toHaveLength(1);
    expect(adapter.capturedToolsCalls[0]).toEqual([
      { name: 'close_session', description: 'closes', parameters: {} },
    ]);
  });
});

describe('main subprocess — init-first enforcement', () => {
  it('exits 2 when a user-message arrives before init', async () => {
    const proc = Bun.spawn(['bun', mainPath], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    proc.stdin.write(`${JSON.stringify({ v: 1, type: 'user-message', id: 'x', text: 'hi' })}\n`);
    await proc.stdin.end();
    expect(await proc.exited).toBe(2);
  });

  it('exits 2 when the first stdin line is malformed JSON', async () => {
    const proc = Bun.spawn(['bun', mainPath], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    proc.stdin.write('this is not json\n');
    await proc.stdin.end();
    expect(await proc.exited).toBe(2);
  });
});
