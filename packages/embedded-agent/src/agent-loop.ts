/**
 * The embedded-agent turn cycle.
 *
 * Owns the in-memory conversation and drives one user turn: stream provider
 * output, emit structured events, execute tool calls through the MCP executor,
 * feed results back, and repeat until the model stops calling tools (or a cap /
 * error / cancel ends the turn). Provider failures retry with backoff; the
 * conversation stays usable after a turn-error so the next user message can
 * continue.
 */

import type { EmbeddedAgentEvent } from '@agent-console/shared';
import type { ToolExecutor } from './mcp.js';
import {
  ProviderError,
  type ChatMessage,
  type ProviderAdapter,
  type ToolCall,
  type ToolDefinition,
} from './providers/types.js';
import { truncateToBytes } from './truncate.js';

const TOOL_RESULT_MAX_BYTES = 16384;
const DEFAULT_RETRY_DELAYS_MS: [number, number] = [500, 2000];
const MAX_PROVIDER_ATTEMPTS = 3;
const MAX_MALFORMED_REASKS = 2;

export interface AgentLoopDeps {
  adapter: ProviderAdapter;
  model: string;
  tools: ToolDefinition[];
  executor: ToolExecutor;
  emit: (event: EmbeddedAgentEvent) => void;
  systemPrompt: string;
  maxToolIterations: number;
  retryDelaysMs?: [number, number];
  sleep?: (ms: number) => Promise<void>;
}

interface ProviderToolCall {
  callId: string;
  name: string;
  argsJson: string;
}

type ProviderOutcome =
  | { kind: 'ok'; text: string; toolCalls: ProviderToolCall[] }
  | { kind: 'error'; message: string }
  | { kind: 'canceled' };

type ParsedToolArgs =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; message: string };

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Parse tool-call arguments and require a plain JSON object. An empty-string
 * argsJson counts as `{}`. Deep JSON-schema validation is deliberately
 * delegated to the MCP server's zod layer; the loop only checks shape.
 */
function parseToolArgs(argsJson: string): ParsedToolArgs {
  const source = argsJson.trim() === '' ? '{}' : argsJson;
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, message: 'tool arguments must be a JSON object' };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

export class AgentLoop {
  private readonly deps: AgentLoopDeps;
  private readonly retryDelaysMs: [number, number];
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly conversation: ChatMessage[];
  private currentAbort: AbortController | null = null;

  constructor(deps: AgentLoopDeps) {
    this.deps = deps;
    this.retryDelaysMs = deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.sleep = deps.sleep ?? defaultSleep;
    this.conversation = [{ role: 'system', content: deps.systemPrompt }];
  }

  /** Abort the in-flight turn, if any. No-op when no turn is active. */
  cancel(): void {
    this.currentAbort?.abort();
  }

  async runTurn(id: string, text: string): Promise<void> {
    const turnId = id;
    const abort = new AbortController();
    this.currentAbort = abort;

    try {
      this.deps.emit({ v: 1, type: 'state', state: 'active' });
      this.conversation.push({ role: 'user', content: text });

      let malformedReAsks = 0;

      for (let iteration = 0; iteration < this.deps.maxToolIterations; iteration++) {
        const outcome = await this.runProviderWithRetries(turnId, abort.signal);
        if (outcome.kind === 'canceled') {
          this.emitTurnError(turnId, 'turn canceled');
          return;
        }
        if (outcome.kind === 'error') {
          this.emitTurnError(turnId, outcome.message);
          return;
        }

        // Always emit the assistant message, even when the text is empty.
        this.deps.emit({ v: 1, type: 'assistant-message', turnId, text: outcome.text });
        this.conversation.push(this.buildAssistantMessage(outcome.text, outcome.toolCalls));

        if (outcome.toolCalls.length === 0) {
          this.emitIdle();
          return;
        }

        for (const call of outcome.toolCalls) {
          const parsed = parseToolArgs(call.argsJson);
          if (!parsed.ok) {
            if (malformedReAsks >= MAX_MALFORMED_REASKS) {
              this.emitTurnError(
                turnId,
                `tool arguments could not be parsed after ${MAX_MALFORMED_REASKS} re-asks: ${parsed.message}`,
              );
              return;
            }
            malformedReAsks++;
            this.conversation.push({
              role: 'tool',
              tool_call_id: call.callId,
              content: `Error: tool arguments were not a valid JSON object (${parsed.message}). Please re-issue the call with corrected arguments.`,
            });
            continue;
          }

          if (abort.signal.aborted) {
            this.emitTurnError(turnId, 'turn canceled');
            return;
          }
          this.deps.emit({
            v: 1,
            type: 'tool-call',
            turnId,
            callId: call.callId,
            name: call.name,
            args: parsed.value,
          });
          const result = await this.deps.executor.callTool(call.name, parsed.value, abort.signal);
          if (abort.signal.aborted) {
            this.emitTurnError(turnId, 'turn canceled');
            return;
          }
          const { text: truncated } = truncateToBytes(result.result, TOOL_RESULT_MAX_BYTES);
          this.deps.emit({
            v: 1,
            type: 'tool-result',
            turnId,
            callId: call.callId,
            ok: result.ok,
            result: truncated,
          });
          this.conversation.push({
            role: 'tool',
            tool_call_id: call.callId,
            content: truncated,
          });
        }
      }

      this.emitTurnError(turnId, 'maximum tool iterations reached');
    } finally {
      this.currentAbort = null;
    }
  }

  private buildAssistantMessage(text: string, toolCalls: ProviderToolCall[]): ChatMessage {
    if (toolCalls.length === 0) {
      return { role: 'assistant', content: text };
    }
    const tool_calls: ToolCall[] = toolCalls.map((call) => ({
      id: call.callId,
      type: 'function',
      function: { name: call.name, arguments: call.argsJson },
    }));
    return { role: 'assistant', content: text, tool_calls };
  }

  private async runProviderWithRetries(
    turnId: string,
    signal: AbortSignal,
  ): Promise<ProviderOutcome> {
    for (let attempt = 1; attempt <= MAX_PROVIDER_ATTEMPTS; attempt++) {
      try {
        return await this.runProviderAttempt(turnId, signal);
      } catch (err) {
        if (signal.aborted) {
          return { kind: 'canceled' };
        }
        if (attempt === MAX_PROVIDER_ATTEMPTS) {
          return { kind: 'error', message: errorMessage(err) };
        }
        await this.sleep(this.retryDelayFor(attempt, err));
        if (signal.aborted) {
          return { kind: 'canceled' };
        }
      }
    }
    // Unreachable: the loop either returns a result or an error at the last attempt.
    return { kind: 'error', message: 'provider retry loop exhausted' };
  }

  private retryDelayFor(attempt: number, err: unknown): number {
    if (err instanceof ProviderError && err.retryAfterMs !== undefined) {
      return err.retryAfterMs;
    }
    return this.retryDelaysMs[attempt - 1] ?? this.retryDelaysMs[this.retryDelaysMs.length - 1];
  }

  private async runProviderAttempt(
    turnId: string,
    signal: AbortSignal,
  ): Promise<{ kind: 'ok'; text: string; toolCalls: ProviderToolCall[] }> {
    let text = '';
    const toolCalls: ProviderToolCall[] = [];

    for await (const event of this.deps.adapter.run({
      model: this.deps.model,
      messages: this.conversation,
      tools: this.deps.tools,
      signal,
    })) {
      switch (event.type) {
        case 'text-delta':
          text += event.text;
          this.deps.emit({ v: 1, type: 'assistant-delta', turnId, text: event.text });
          break;
        case 'tool-call':
          toolCalls.push({ callId: event.callId, name: event.name, argsJson: event.argsJson });
          break;
        case 'done':
          break;
      }
    }

    return { kind: 'ok', text, toolCalls };
  }

  private emitTurnError(turnId: string, message: string): void {
    this.deps.emit({ v: 1, type: 'turn-error', turnId, message });
    this.emitIdle();
  }

  private emitIdle(): void {
    this.deps.emit({ v: 1, type: 'state', state: 'idle' });
  }
}
