/**
 * Embedded-agent subprocess entry point.
 *
 * Reads NDJSON commands on stdin (the first MUST be a valid `init`), emits
 * NDJSON events on stdout, and routes all diagnostics to stderr. The
 * command-dispatch core is the exported `runLoop`, with injectable factories so
 * it is testable without a real MCP server, provider, or filesystem; a thin
 * `import.meta.main` bootstrap wires the production implementations.
 */

import { NdjsonLineSplitter, type EmbeddedAgentEvent } from '@agent-console/shared';
import * as v from 'valibot';
import { EmbeddedAgentCommandSchema } from '@agent-console/shared';
import { AgentLoop } from './agent-loop.js';
import { McpToolClient, type ToolExecutor } from './mcp.js';
import { OpenAIChatAdapter } from './providers/openai-chat-adapter.js';
import type { ProviderAdapter, ToolDefinition } from './providers/types.js';
import { assembleSystemPrompt, readAgentsMd } from './system-prompt.js';
import { resolveEnabledBuiltinTools } from './tools/index.js';
import { CompositeToolExecutor } from './tools/composite-executor.js';

const EXIT_OK = 0;
const EXIT_FATAL = 1;
const EXIT_PROTOCOL = 2;
const KNOWN_COMMAND_TYPES = new Set(['init', 'user-message', 'cancel', 'shutdown']);
// 500ms buffer over KILL_GRACE_MS to allow SIGKILL escalation on shutdown, per PR #1063 architect note
const TURN_DRAIN_TIMEOUT_MS = 2500;

/** IO seam so the loop can be driven by a test harness or the real process. */
export interface LoopIO {
  readCommands(): AsyncIterable<string>;
  writeEvent(event: EmbeddedAgentEvent): void;
  logError(message: string): void;
}

/** MCP client surface: connection plus the executor the loop consumes. */
export interface McpClientLike extends ToolExecutor {
  connect(baseUrl: string, token: string): Promise<void>;
}

/** Injectable construction of the loop's external dependencies. */
export interface LoopFactories {
  createMcpClient(): McpClientLike;
  createAdapter(opts: { baseUrl: string; apiKey?: string }): ProviderAdapter;
  readAgentsMd(cwd: string): Promise<string | null>;
}

type InitCommand = Extract<v.InferOutput<typeof EmbeddedAgentCommandSchema>, { type: 'init' }>;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run the embedded-agent command loop. Returns the process exit code.
 * Never throws: fatal conditions emit a `fatal` event (best-effort) and resolve
 * with exit code 1.
 */
export async function runLoop(io: LoopIO, factories: LoopFactories): Promise<number> {
  let loop: AgentLoop | null = null;
  let currentTurn: Promise<void> | null = null;
  let turnActive = false;

  for await (const raw of io.readCommands()) {
    const line = raw.trim();
    if (line === '') continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      io.logError('Malformed JSON on stdin; exiting');
      return EXIT_PROTOCOL;
    }

    const type = (parsed as { type?: unknown }).type;

    // The first accepted command MUST be a valid init.
    if (loop === null) {
      const result = v.safeParse(EmbeddedAgentCommandSchema, parsed);
      if (!result.success || result.output.type !== 'init') {
        io.logError('First stdin message must be a valid init command; exiting');
        return EXIT_PROTOCOL;
      }
      const init = await initializeLoop(io, factories, result.output);
      if (init === null) {
        return EXIT_FATAL;
      }
      loop = init;
      continue;
    }

    // Forward-compat: ignore unknown command types after init.
    if (typeof type !== 'string' || !KNOWN_COMMAND_TYPES.has(type)) {
      io.logError(`Ignoring stdin message with unknown type: ${String(type)}`);
      continue;
    }

    const result = v.safeParse(EmbeddedAgentCommandSchema, parsed);
    if (!result.success) {
      io.logError(`Known command failed schema validation (${type}); exiting`);
      return EXIT_PROTOCOL;
    }
    const command = result.output;

    switch (command.type) {
      case 'init':
        io.logError('Ignoring duplicate init command');
        break;
      case 'user-message': {
        if (turnActive) {
          io.logError('Ignoring user-message received while a turn is active');
          break;
        }
        turnActive = true;
        currentTurn = loop
          .runTurn(command.id, command.text)
          .catch((err) => {
            io.logError(`Turn failed: ${err instanceof Error ? err.message : String(err)}`);
          })
          .finally(() => {
            turnActive = false;
          });
        break;
      }
      case 'cancel':
        loop.cancel();
        break;
      case 'shutdown':
        return await gracefulExit(loop, currentTurn);
    }
  }

  // stdin EOF: same as shutdown.
  return await gracefulExit(loop, currentTurn);
}

async function initializeLoop(
  io: LoopIO,
  factories: LoopFactories,
  init: InitCommand,
): Promise<AgentLoop | null> {
  const agentsMd = await factories.readAgentsMd(init.context.cwd);
  const systemPrompt = assembleSystemPrompt({
    context: init.context,
    agentsMd,
    definitionSystemPrompt: init.systemPrompt,
  });

  const mcp = factories.createMcpClient();
  let tools: ToolDefinition[];
  let executor: ToolExecutor;
  try {
    await mcp.connect(init.mcp.baseUrl, init.mcp.token);
    const builtins = resolveEnabledBuiltinTools(init.enabledTools);
    const composite = new CompositeToolExecutor({
      mcp,
      builtins,
      ctx: { locationPath: init.context.cwd },
      onNameCollision: (name) =>
        io.logError(`Builtin tool "${name}" collides with an MCP tool of the same name; builtin wins`),
    });
    tools = await composite.listTools();
    executor = composite;
  } catch (err) {
    const message = `MCP connection failed: ${err instanceof Error ? err.message : String(err)}`;
    io.writeEvent({ v: 1, type: 'fatal', message });
    io.logError(message);
    return null;
  }

  const adapter = factories.createAdapter({
    baseUrl: init.provider.baseUrl,
    apiKey: init.provider.apiKey,
  });

  const loop = new AgentLoop({
    adapter,
    model: init.provider.model,
    tools,
    executor,
    emit: (event) => io.writeEvent(event),
    systemPrompt,
    maxToolIterations: init.maxToolIterations,
  });

  io.writeEvent({ v: 1, type: 'ready' });
  return loop;
}

async function gracefulExit(
  loop: AgentLoop | null,
  currentTurn: Promise<void> | null,
): Promise<number> {
  if (loop !== null && currentTurn !== null) {
    loop.cancel();
    await Promise.race([currentTurn, delay(TURN_DRAIN_TIMEOUT_MS)]);
  }
  return EXIT_OK;
}

async function* readStdinLines(): AsyncIterable<string> {
  const splitter = new NdjsonLineSplitter();
  const decoder = new TextDecoder();
  for await (const chunk of Bun.stdin.stream()) {
    const { lines } = splitter.push(decoder.decode(chunk, { stream: true }));
    for (const line of lines) yield line;
  }
  const tail = splitter.carry;
  if (tail.length > 0) yield tail;
}

function writeEvent(event: EmbeddedAgentEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

if (import.meta.main) {
  const io: LoopIO = {
    readCommands: readStdinLines,
    writeEvent,
    logError: (message) => console.error(message),
  };
  const factories: LoopFactories = {
    createMcpClient: () => new McpToolClient(),
    createAdapter: (opts) => new OpenAIChatAdapter(opts),
    readAgentsMd,
  };
  runLoop(io, factories)
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(EXIT_FATAL);
    });
}
