import { describe, it, expect } from 'bun:test';
import { McpToolClient, type McpClientHandle } from '../mcp.js';

interface CallToolArgs {
  params: { name: string; arguments?: Record<string, unknown> };
  options?: { signal?: AbortSignal };
}

function makeClient(overrides: Partial<McpClientHandle> = {}): McpClientHandle {
  return {
    listTools: async () => ({ tools: [] }),
    callTool: async () => ({ content: [] }),
    ...overrides,
  };
}

async function connected(handle: McpClientHandle): Promise<McpToolClient> {
  const client = new McpToolClient({ connectClient: async () => handle });
  await client.connect('http://localhost/mcp', 'token');
  return client;
}

describe('McpToolClient — listTools', () => {
  it('maps MCP inputSchema 1:1 onto parameters, preserving name and description', async () => {
    const handle = makeClient({
      listTools: async () => ({
        tools: [
          {
            name: 'close_session',
            description: 'Close a session',
            inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } } },
          },
          { name: 'no_desc', inputSchema: { type: 'object' } },
        ],
      }),
    });
    const client = await connected(handle);

    expect(await client.listTools()).toEqual([
      {
        name: 'close_session',
        description: 'Close a session',
        parameters: { type: 'object', properties: { sessionId: { type: 'string' } } },
      },
      { name: 'no_desc', description: undefined, parameters: { type: 'object' } },
    ]);
  });
});

describe('McpToolClient — callTool', () => {
  it('concatenates text content parts and reports ok when isError is absent', async () => {
    const handle = makeClient({
      callTool: async () => ({
        content: [
          { type: 'text', text: 'Hello ' },
          { type: 'text', text: 'world' },
        ],
      }),
    });
    const client = await connected(handle);

    expect(await client.callTool('t', {}, new AbortController().signal)).toEqual({
      ok: true,
      result: 'Hello world',
    });
  });

  it('JSON-stringifies non-text content parts', async () => {
    const handle = makeClient({
      callTool: async () => ({
        content: [
          { type: 'text', text: 'see: ' },
          { type: 'image', data: 'abc', mimeType: 'image/png' },
        ],
      }),
    });
    const client = await connected(handle);

    const outcome = await client.callTool('t', {}, new AbortController().signal);
    expect(outcome.ok).toBe(true);
    expect(outcome.result).toBe('see: {"type":"image","data":"abc","mimeType":"image/png"}');
  });

  it('returns ok:false when the tool result isError is true', async () => {
    const handle = makeClient({
      callTool: async () => ({ content: [{ type: 'text', text: 'boom' }], isError: true }),
    });
    const client = await connected(handle);

    expect(await client.callTool('t', {}, new AbortController().signal)).toEqual({
      ok: false,
      result: 'boom',
    });
  });

  it('returns ok:false with the error message when the SDK call rejects', async () => {
    const handle = makeClient({
      callTool: async () => {
        throw new Error('transport closed');
      },
    });
    const client = await connected(handle);

    expect(await client.callTool('t', {}, new AbortController().signal)).toEqual({
      ok: false,
      result: 'transport closed',
    });
  });

  it('forwards the abort signal and arguments in the request options', async () => {
    let captured: CallToolArgs | null = null;
    const handle = makeClient({
      callTool: async (params, _resultSchema, options) => {
        captured = { params, options };
        return { content: [] };
      },
    });
    const client = await connected(handle);
    const signal = new AbortController().signal;

    await client.callTool('do_thing', { a: 1 }, signal);
    expect(captured!.params).toEqual({ name: 'do_thing', arguments: { a: 1 } });
    expect(captured!.options?.signal).toBe(signal);
  });
});

describe('McpToolClient — usage before connect', () => {
  it('throws when listTools is called before connect', async () => {
    const client = new McpToolClient({ connectClient: async () => makeClient() });
    await expect(client.listTools()).rejects.toThrow('connect must be called');
  });
});
