/**
 * Shared MCP JSON-RPC session helpers, extracted for
 * delegate-embedded-agent-activation.test.ts (Issue #1260 PR-1) from the
 * pattern already inlined in mcp-server.test.ts, to avoid a second inline
 * copy of the same boilerplate in this new file.
 */
import type { Hono } from 'hono';

/**
 * Initialize MCP session by sending the initialize request and
 * notifications/initialized. Returns the Mcp-Session-Id header value.
 */
export async function initializeMcp(app: Hono, extraHeaders?: Record<string, string>): Promise<string> {
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      ...extraHeaders,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
      id: 1,
    }),
  });

  const sessionId = res.headers.get('mcp-session-id') ?? '';

  await app.request('/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Mcp-Session-Id': sessionId,
      ...extraHeaders,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }),
  });

  return sessionId;
}

/** Call an MCP tool and return the parsed JSON-RPC response. */
export async function callTool(
  app: Hono,
  sessionId: string,
  name: string,
  args: Record<string, unknown>,
  id: number = 2,
  extraHeaders?: Record<string, string>,
): Promise<{ result?: { content: Array<{ type: string; text: string }>; isError?: boolean }; error?: unknown }> {
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Mcp-Session-Id': sessionId,
      ...extraHeaders,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name, arguments: args },
      id,
    }),
  });

  return (await res.json()) as {
    result?: { content: Array<{ type: string; text: string }>; isError?: boolean };
    error?: unknown;
  };
}

/** Extract the parsed text content from a tool call result. */
export function parseToolResult(response: Awaited<ReturnType<typeof callTool>>): unknown {
  const text = response.result?.content?.[0]?.text;
  if (!text) return undefined;
  return JSON.parse(text);
}
