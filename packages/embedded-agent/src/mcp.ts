/**
 * MCP tool client for the embedded-agent loop.
 *
 * Wraps the official MCP SDK client over a Streamable HTTP transport carrying a
 * per-worker bearer token. Exposes a narrow `ToolExecutor` interface so the
 * agent loop can be tested against a stub without a live MCP server.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ToolDefinition } from './providers/types.js';

export interface ToolCallOutcome {
  ok: boolean;
  result: string;
}

/** Narrow tool-execution surface the agent loop depends on. */
export interface ToolExecutor {
  listTools(): Promise<ToolDefinition[]>;
  callTool(name: string, args: unknown, signal: AbortSignal): Promise<ToolCallOutcome>;
}

/**
 * The narrow subset of the connected MCP SDK client this wrapper drives. The
 * real `Client` satisfies it structurally; a test can supply a stub.
 */
export interface McpClientHandle {
  listTools(): Promise<{
    tools: Array<{ name: string; description?: string; inputSchema: unknown }>;
  }>;
  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    resultSchema?: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<{ content?: unknown; isError?: boolean }>;
}

/** Establishes a connected client for a bearer-authenticated Streamable HTTP endpoint. */
export type ConnectClientFn = (baseUrl: string, token: string) => Promise<McpClientHandle>;

async function defaultConnectClient(baseUrl: string, token: string): Promise<McpClientHandle> {
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'agent-console-embedded-agent', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

interface McpTextPart {
  type: 'text';
  text: string;
}

function isTextPart(part: unknown): part is McpTextPart {
  return (
    typeof part === 'object' &&
    part !== null &&
    (part as { type?: unknown }).type === 'text' &&
    typeof (part as { text?: unknown }).text === 'string'
  );
}

/** Concatenate text content parts; JSON-stringify any non-text parts. */
function extractResultText(res: unknown): string {
  const content = (res as { content?: unknown }).content;
  if (Array.isArray(content)) {
    return content.map((part) => (isTextPart(part) ? part.text : JSON.stringify(part))).join('');
  }
  return JSON.stringify(res);
}

export class McpToolClient implements ToolExecutor {
  private readonly connectClient: ConnectClientFn;
  private client: McpClientHandle | null = null;

  constructor(opts: { connectClient?: ConnectClientFn } = {}) {
    this.connectClient = opts.connectClient ?? defaultConnectClient;
  }

  async connect(baseUrl: string, token: string): Promise<void> {
    this.client = await this.connectClient(baseUrl, token);
  }

  async listTools(): Promise<ToolDefinition[]> {
    const { tools } = await this.requireClient().listTools();
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    }));
  }

  async callTool(name: string, args: unknown, signal: AbortSignal): Promise<ToolCallOutcome> {
    try {
      const res = await this.requireClient().callTool(
        { name, arguments: args as Record<string, unknown> | undefined },
        undefined,
        { signal },
      );
      return { ok: res.isError !== true, result: extractResultText(res) };
    } catch (err) {
      return { ok: false, result: err instanceof Error ? err.message : String(err) };
    }
  }

  private requireClient(): McpClientHandle {
    if (this.client === null) {
      throw new Error('McpToolClient.connect must be called before use');
    }
    return this.client;
  }
}
