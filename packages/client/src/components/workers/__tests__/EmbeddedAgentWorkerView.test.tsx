import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EmbeddedAgentWorkerView } from '../EmbeddedAgentWorkerView';
import { MockWebSocket, installMockWebSocket } from '../../../test/mock-websocket';
import { _resetEmbeddedAgentWorkers } from '../embedded-agent-store';

function ndjson(...events: Record<string, unknown>[]): string {
  return events.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

// MessagePanel (now embedded via EmbeddedAgentWorkerView) always fetches
// message templates (a feature that works identically in embedded and PTY
// per the architect's design), so this suite needs a minimal fetch mock even
// though slash-completion/attachments are disabled for the embedded variant.
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function embeddedViewFetch(input: RequestInfo | URL): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.endsWith('/api/skills')) return Promise.resolve(jsonResponse({ skills: [] }));
  if (url.endsWith('/api/message-templates')) return Promise.resolve(jsonResponse({ templates: [] }));
  return Promise.resolve(new Response('null', { status: 404 }));
}

/** Render EmbeddedAgentWorkerView with the QueryClientProvider MessagePanel needs. */
function renderView(props: { sessionId: string; workerId: string }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <EmbeddedAgentWorkerView {...props} />
    </QueryClientProvider>,
  );
}

describe('EmbeddedAgentWorkerView', () => {
  const originalFetch = globalThis.fetch;
  let restoreWebSocket: () => void;
  let originalLocation: PropertyDescriptor | undefined;

  beforeEach(() => {
    _resetEmbeddedAgentWorkers();
    restoreWebSocket = installMockWebSocket();
    originalLocation = Object.getOwnPropertyDescriptor(window, 'location');
    Object.defineProperty(window, 'location', {
      value: { protocol: 'http:', host: 'localhost:3000' },
      writable: true,
      configurable: true,
    });
    const fetchStub: typeof fetch = Object.assign(mock(embeddedViewFetch), { preconnect: () => {} });
    globalThis.fetch = fetchStub;
  });

  afterEach(() => {
    cleanup();
    _resetEmbeddedAgentWorkers();
    restoreWebSocket();
    globalThis.fetch = originalFetch;
    if (originalLocation) {
      Object.defineProperty(window, 'location', originalLocation);
    }
  });

  it('always renders the persistent reset-on-restart note', () => {
    renderView({ sessionId: 's1', workerId: 'w1' });

    expect(
      screen.getByText(/Conversation resets when this worker or the server restarts/i),
    ).toBeTruthy();
  });

  it('always renders the experimental-agent notice', () => {
    renderView({ sessionId: 's1c', workerId: 'w1c' });

    expect(
      screen.getByText('This is an experimental Embedded Agent. Restart resets the conversation.'),
    ).toBeTruthy();
  });

  it('mounts MessagePanel with an accessible name for the message input', () => {
    renderView({ sessionId: 's1b', workerId: 'w1b' });

    expect(screen.getByPlaceholderText('Send message to worker... (Ctrl+Enter to send)')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Message input' })).toBeTruthy();
  });

  it('gates sending (not the textarea) while a turn is active, and still shows Cancel', async () => {
    const user = userEvent.setup();
    renderView({ sessionId: 's2', workerId: 'w2' });
    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
    });

    expect(screen.queryByText('Cancel')).toBeNull();
    const textarea = screen.getByPlaceholderText('Send message to worker... (Ctrl+Enter to send)') as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(false);

    act(() => {
      ws?.simulateMessage(JSON.stringify({ type: 'activity', state: 'active' }));
    });
    await flush();

    // The textarea itself stays fully editable while a turn is active.
    expect(textarea.disabled).toBe(false);
    await user.type(textarea, 'still typing');
    expect(textarea.value).toBe('still typing');

    // Only the Send action is gated.
    const sendButton = screen.getByText('Send') as HTMLButtonElement;
    expect(sendButton.disabled).toBe(true);
    expect(screen.getByText('Cancel')).toBeTruthy();
  });

  it('re-enables sending and hides Cancel once activity returns to idle', async () => {
    renderView({ sessionId: 's3', workerId: 'w3' });
    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
      ws?.simulateMessage(JSON.stringify({ type: 'activity', state: 'active' }));
    });
    await flush();
    expect(screen.getByText('Cancel')).toBeTruthy();

    act(() => {
      ws?.simulateMessage(JSON.stringify({ type: 'activity', state: 'idle' }));
    });
    await flush();

    expect(screen.queryByText('Cancel')).toBeNull();
    const textarea = screen.getByPlaceholderText('Send message to worker... (Ctrl+Enter to send)') as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(false);
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'hello' } });
    });
    const sendButton = screen.getByText('Send') as HTMLButtonElement;
    expect(sendButton.disabled).toBe(false);
  });

  it('sends a message on Ctrl+Enter and clears the draft', async () => {
    renderView({ sessionId: 's4', workerId: 'w4' });
    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
    });

    const textarea = screen.getByPlaceholderText('Send message to worker... (Ctrl+Enter to send)');
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'hello agent' } });
    });
    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    });

    const sent = (ws!.send.mock.calls as string[][]).map((c) => JSON.parse(c[0]));
    expect(sent).toContainEqual({ type: 'embedded-user-message', text: 'hello agent' });
    expect((textarea as HTMLTextAreaElement).value).toBe('');
  });

  it('renders a turn-in-progress error non-fatally, with a Dismiss action, keeping entries', async () => {
    renderView({ sessionId: 's5', workerId: 'w5' });
    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
    });

    const data = ndjson({ v: 1, type: 'user-message', id: 'u1', text: 'hi' });
    act(() => {
      ws?.simulateMessage(JSON.stringify({ type: 'history', data, offset: data.length, startOffset: 0, epoch: 1 }));
    });
    await flush();
    expect(screen.getByText('hi')).toBeTruthy();

    act(() => {
      ws?.simulateMessage(JSON.stringify({ type: 'error', message: 'turn in progress', code: 'TURN_IN_PROGRESS' }));
    });
    await flush();

    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText('turn in progress')).toBeTruthy();
    expect(screen.getByText('Dismiss')).toBeTruthy();
    // The prior message is still rendered -- a non-fatal error must not clear the conversation.
    expect(screen.getByText('hi')).toBeTruthy();

    const user = userEvent.setup();
    await user.click(screen.getByText('Dismiss'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders an ACTIVATION_FAILED error with a Retry action instead of Dismiss', async () => {
    renderView({ sessionId: 's6', workerId: 'w6' });
    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
      ws?.simulateMessage(JSON.stringify({ type: 'error', message: 'dangling definition', code: 'ACTIVATION_FAILED' }));
    });
    await flush();

    expect(screen.getByText('dangling definition')).toBeTruthy();
    expect(screen.getByText('Retry')).toBeTruthy();
    expect(screen.queryByText('Dismiss')).toBeNull();
  });

  it('renders an exited row with a Restart action that reconnects', async () => {
    renderView({ sessionId: 's7', workerId: 'w7' });
    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
    });

    const data = ndjson({ v: 1, type: 'exited', code: 1 });
    act(() => {
      ws?.simulateMessage(JSON.stringify({ type: 'history', data, offset: data.length, startOffset: 0, epoch: 1 }));
    });
    await flush();

    expect(screen.getByText(/Agent process exited \(code: 1\)/)).toBeTruthy();
    const restartButton = screen.getByText('Restart');

    const user = userEvent.setup();
    await user.click(restartButton);

    // Restart forces a fresh WS connection.
    const secondWs = MockWebSocket.getLastInstance();
    expect(secondWs).not.toBe(ws);
  });

  it('renders a tool-call card paired with its tool-result, including error styling data', async () => {
    renderView({ sessionId: 's8', workerId: 'w8' });
    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
    });

    const data = ndjson(
      { v: 1, type: 'tool-call', turnId: 't1', callId: 'c1', name: 'run_process', args: { cmd: 'ls' } },
      { v: 1, type: 'tool-result', turnId: 't1', callId: 'c1', ok: false, result: 'boom' },
    );
    act(() => {
      ws?.simulateMessage(JSON.stringify({ type: 'history', data, offset: data.length, startOffset: 0, epoch: 1 }));
    });
    await flush();

    expect(screen.getByText('run_process')).toBeTruthy();
    expect(screen.getByText('boom')).toBeTruthy();
  });

  it('appends streaming assistant-delta text live', async () => {
    renderView({ sessionId: 's9', workerId: 'w9' });
    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
    });

    const chunk = ndjson({ v: 1, type: 'assistant-delta', turnId: 't1', text: 'Hello' });
    act(() => {
      ws?.simulateMessage(JSON.stringify({ type: 'output', data: chunk, offset: chunk.length, epoch: 1 }));
    });
    await flush();

    expect(screen.getByText('Hello')).toBeTruthy();
  });
});
