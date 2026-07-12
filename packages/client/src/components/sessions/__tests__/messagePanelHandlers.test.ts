import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { getOrCreateTerminal, _resetTerminals } from '../../terminal/terminal-store';
import { sendPtyWorkerMessage, escapePtyWorker } from '../messagePanelHandlers';

// --- Fetch-level API mocking (no mock.module; testing.md Anti-Pattern #2). ---
// Same technique as MessagePanel.test.tsx's messagePanelFetch: mock the
// communication layer and assert on the recorded fetch calls.
const fetchCalls: Array<{ url: string; method: string; body: unknown }> = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const SENT_MESSAGE = {
  id: 'msg-1',
  sessionId: 'session-1',
  fromWorkerId: 'user',
  fromWorkerName: 'User',
  toWorkerId: 'agent-1',
  toWorkerName: 'Agent 1',
  content: 'hello',
  timestamp: new Date().toISOString(),
};

function messagesFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? 'GET').toUpperCase();
  fetchCalls.push({ url, method, body: init?.body });
  if (/\/api\/sessions\/[^/]+\/messages$/.test(url) && method === 'POST') {
    return Promise.resolve(jsonResponse({ message: SENT_MESSAGE }));
  }
  return Promise.resolve(new Response('null', { status: 404 }));
}

/** POST /api/sessions/:id/messages calls captured by the mock (the sendWorkerMessage transport). */
function sentMessageCalls(): Array<{ url: string; sessionId: string; content: string | null; toWorkerId: string | null; files: FormDataEntryValue[] }> {
  return fetchCalls
    .filter((c) => /\/api\/sessions\/[^/]+\/messages$/.test(c.url) && c.method === 'POST')
    .map((c) => {
      const fd = c.body as FormData;
      const sessionId = c.url.match(/\/api\/sessions\/([^/]+)\/messages$/)?.[1] ?? '';
      return {
        url: c.url,
        sessionId,
        content: fd.get('content') as string | null,
        toWorkerId: fd.get('toWorkerId') as string | null,
        files: fd.getAll('files'),
      };
    });
}

describe('sendPtyWorkerMessage', () => {
  const originalFetch = globalThis.fetch;
  let originalLocation: PropertyDescriptor | undefined;

  beforeEach(() => {
    fetchCalls.length = 0;
    originalLocation = Object.getOwnPropertyDescriptor(window, 'location');
    Object.defineProperty(window, 'location', {
      value: { protocol: 'http:', host: 'localhost:3000' },
      writable: true,
      configurable: true,
    });
    const fetchStub: typeof fetch = Object.assign(mock(messagesFetch), { preconnect: () => {} });
    globalThis.fetch = fetchStub;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalLocation) Object.defineProperty(window, 'location', originalLocation);
  });

  it('POSTs to /api/sessions/:id/messages with the expected FormData fields', async () => {
    await sendPtyWorkerMessage('session-1', 'agent-1', 'hello');

    const sent = sentMessageCalls();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ sessionId: 'session-1', toWorkerId: 'agent-1', content: 'hello' });
    expect(sent[0].files).toHaveLength(0);
  });

  it('includes attached files in the FormData', async () => {
    const file = new File(['data'], 'test.png', { type: 'image/png' });
    await sendPtyWorkerMessage('session-1', 'agent-1', 'hello', [file]);

    const sent = sentMessageCalls();
    expect(sent).toHaveLength(1);
    expect(sent[0].files).toHaveLength(1);
  });
});

describe('escapePtyWorker', () => {
  beforeEach(() => {
    _resetTerminals();
  });

  afterEach(() => {
    _resetTerminals();
  });

  it('sends the ESC byte through the terminal store instance for this session/worker', () => {
    const instance = getOrCreateTerminal('session-1', 'agent-1');
    const spy = mock((_data: string) => {});
    instance.sendInput = spy;

    escapePtyWorker('session-1', 'agent-1');

    expect(spy).toHaveBeenCalledWith('\x1b');
  });
});
