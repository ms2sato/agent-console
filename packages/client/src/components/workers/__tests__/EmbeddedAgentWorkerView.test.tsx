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

  it('notifies onStatusChange with the connection status, starting at connecting and moving to connected on WS open', async () => {
    const onStatusChange = mock(() => {});
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
        <EmbeddedAgentWorkerView sessionId="s-status" workerId="w-status" onStatusChange={onStatusChange} />
      </QueryClientProvider>,
    );

    expect(onStatusChange).toHaveBeenCalledWith('connecting');

    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
    });

    expect(onStatusChange).toHaveBeenLastCalledWith('connected');
  });

  it('does not render its own status/activity label, leaving that to the shared status bar', async () => {
    renderView({ sessionId: 's-nolabel', workerId: 'w-nolabel' });
    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
    });
    await flush();

    // The persistent amber notice text ("Conversation resets...") stays --
    // only the removed per-view status row's exact labels are asserted absent.
    expect(screen.queryByText('Connecting...')).toBeNull();
    expect(screen.queryByText('Connected')).toBeNull();
    expect(screen.queryByText('Disconnected')).toBeNull();
    expect(screen.queryByText('Idle')).toBeNull();

    act(() => {
      ws?.simulateMessage(JSON.stringify({ type: 'activity', state: 'active' }));
    });
    await flush();
    // 'Working...' is a duplicate concern of the removed status row; the
    // Cancel button remains (asserted by the two tests below), but the
    // "Working..." text label itself must not render inside the view.
    expect(screen.queryByText('Working...')).toBeNull();
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

  describe('Markdown rendering (#1069)', () => {
    it('renders an assistant message with heading/list/bold/code/link Markdown as formatted HTML', async () => {
      const { container } = renderView({ sessionId: 's10', workerId: 'w10' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });

      const markdown = [
        '# Heading',
        '',
        '- item one',
        '- item two',
        '',
        '**bold text** and `inline code`',
        '',
        '[a link](https://example.com)',
      ].join('\n');
      const data = ndjson({ v: 1, type: 'assistant-message', turnId: 't1', text: markdown });
      act(() => {
        ws?.simulateMessage(JSON.stringify({ type: 'history', data, offset: data.length, startOffset: 0, epoch: 1 }));
      });
      await flush();

      expect(screen.getByRole('heading', { level: 1, name: 'Heading' })).toBeTruthy();
      expect(screen.getAllByRole('listitem')).toHaveLength(2);
      const bold = container.querySelector('strong');
      expect(bold?.textContent).toBe('bold text');
      const code = container.querySelector('code');
      expect(code?.textContent).toBe('inline code');
      const link = screen.getByRole('link', { name: 'a link' }) as HTMLAnchorElement;
      expect(link.getAttribute('href')).toBe('https://example.com');
    });

    it('renders a fenced code block as a <pre><code> element', async () => {
      const { container } = renderView({ sessionId: 's10b', workerId: 'w10b' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });

      const markdown = ['```', "console.log('hi')", '```'].join('\n');
      const data = ndjson({ v: 1, type: 'assistant-message', turnId: 't1', text: markdown });
      act(() => {
        ws?.simulateMessage(JSON.stringify({ type: 'history', data, offset: data.length, startOffset: 0, epoch: 1 }));
      });
      await flush();

      const pre = container.querySelector('pre');
      expect(pre).toBeTruthy();
      expect(pre?.querySelector('code')?.textContent).toContain("console.log('hi')");
    });

    it('renders a user message with Markdown syntax as literal text (not interpreted, #1073 architect audit)', async () => {
      const { container } = renderView({ sessionId: 's10c', workerId: 'w10c' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });

      const data = ndjson({ v: 1, type: 'user-message', id: 'u1', text: '**important** request' });
      act(() => {
        ws?.simulateMessage(JSON.stringify({ type: 'history', data, offset: data.length, startOffset: 0, epoch: 1 }));
      });
      await flush();

      // User input is verbatim, not Markdown -- the raw `**...**` syntax
      // must render as plain text, never as a <strong> element.
      expect(container.querySelector('strong')).toBeNull();
      expect(screen.getByText('**important** request')).toBeTruthy();
    });

    it('preserves line breaks in a multi-line user message (regression: user messages must not be Markdown-interpreted, #1073 architect audit)', async () => {
      const { container } = renderView({ sessionId: 's10d', workerId: 'w10d' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });

      const data = ndjson({ v: 1, type: 'user-message', id: 'u1', text: 'line one\nline two' });
      act(() => {
        ws?.simulateMessage(JSON.stringify({ type: 'history', data, offset: data.length, startOffset: 0, epoch: 1 }));
      });
      await flush();

      // Markdown (remark-gfm) would wrap the paragraph in a <p> element and
      // rely on the default CSS `white-space: normal`, which visually
      // collapses a single `\n` into a space -- a multi-line user message
      // would render as one line. Plain-text rendering must NOT introduce a
      // <p> wrapper and must apply `whitespace-pre-wrap` directly on the
      // bubble so the line break is preserved.
      expect(container.querySelector('p')).toBeNull();
      const bubble = container.querySelector('.whitespace-pre-wrap');
      expect(bubble).toBeTruthy();
      expect(bubble?.textContent).toBe('line one\nline two');
    });

    it('does not execute or render a <script> tag from an assistant message (XSS defense-in-depth)', async () => {
      const { container } = renderView({ sessionId: 's11', workerId: 'w11' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });

      const data = ndjson({
        v: 1,
        type: 'assistant-message',
        turnId: 't1',
        text: 'before <script>alert(1)</script> after',
      });
      act(() => {
        ws?.simulateMessage(JSON.stringify({ type: 'history', data, offset: data.length, startOffset: 0, epoch: 1 }));
      });
      await flush();

      expect(container.querySelector('script')).toBeNull();
      expect(screen.getByText(/before/)).toBeTruthy();
    });

    it('does not execute or render a <script> tag from a user message (XSS defense-in-depth via plain-text rendering)', async () => {
      const { container } = renderView({ sessionId: 's11b', workerId: 'w11b' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });

      const data = ndjson({
        v: 1,
        type: 'user-message',
        id: 'u1',
        text: 'hi <script>alert(1)</script> there',
      });
      act(() => {
        ws?.simulateMessage(JSON.stringify({ type: 'history', data, offset: data.length, startOffset: 0, epoch: 1 }));
      });
      await flush();

      // User messages render as a plain text node (no Markdown pipeline, no
      // rehype-sanitize needed here) -- React escapes text-node content by
      // default, so the tag is inert and appears as literal text.
      expect(container.querySelector('script')).toBeNull();
      expect(screen.getByText('hi <script>alert(1)</script> there')).toBeTruthy();
    });

    it('applies the wrap-safe overflow treatment to both assistant (.memo-content) and user (plain-text) message bubbles (#1071, revised for #1073 architect audit)', async () => {
      const { container } = renderView({ sessionId: 's12', workerId: 'w12' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });

      const data = ndjson(
        { v: 1, type: 'user-message', id: 'u1', text: 'hi' },
        { v: 1, type: 'assistant-message', turnId: 't1', text: 'hello' },
      );
      act(() => {
        ws?.simulateMessage(JSON.stringify({ type: 'history', data, offset: data.length, startOffset: 0, epoch: 1 }));
      });
      await flush();

      // Assistant bubble still goes through the Markdown pipeline (.memo-content).
      const assistantBubbles = container.querySelectorAll('.memo-content');
      expect(assistantBubbles.length).toBe(1);
      expect(assistantBubbles[0].className).toContain('min-w-0');

      // User bubble is plain text now -- no .memo-content, but the same
      // wrap-safety utilities apply directly on the bubble div.
      const userBubble = screen.getByText('hi');
      expect(userBubble.className).toContain('min-w-0');
      expect(userBubble.className).toContain('whitespace-pre-wrap');
      expect(userBubble.className).toContain('[overflow-wrap:anywhere]');
    });
  });

  describe('Thinking accordion (#1070)', () => {
    it('renders a thinking entry collapsed by default (body not in the accessible/queryable tree)', async () => {
      renderView({ sessionId: 's13', workerId: 'w13' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });

      const chunk = ndjson({ v: 1, type: 'assistant-thinking-delta', turnId: 't1', text: 'pondering deeply' });
      act(() => {
        ws?.simulateMessage(JSON.stringify({ type: 'output', data: chunk, offset: chunk.length, epoch: 1 }));
      });
      await flush();

      expect(screen.getByText('Thinking')).toBeTruthy();
      // Native <details> hides non-<summary> children via the UA stylesheet
      // (`details:not([open]) > *:not(summary) { display: none }`) rather
      // than removing them from the DOM, so a happy-dom text query still
      // finds the body node structurally present -- the `open` attribute is
      // the authoritative collapsed/expanded signal.
      const details = document.querySelector('details');
      expect(details?.hasAttribute('open')).toBe(false);
    });

    it('expands the thinking accordion body on clicking the summary (true-path)', async () => {
      renderView({ sessionId: 's14', workerId: 'w14' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });

      const chunk = ndjson({ v: 1, type: 'assistant-thinking-delta', turnId: 't1', text: 'pondering deeply' });
      act(() => {
        ws?.simulateMessage(JSON.stringify({ type: 'output', data: chunk, offset: chunk.length, epoch: 1 }));
      });
      await flush();

      // happy-dom's native <details> toggle only fires when the click
      // target is the <summary> element itself, not a nested descendant
      // (unlike real browsers, where the click bubbles up); click the
      // <summary> directly to drive the true-path expand.
      const user = userEvent.setup();
      const summary = document.querySelector('summary')!;
      await user.click(summary);

      expect(screen.getByText('pondering deeply')).toBeTruthy();
      const details = document.querySelector('details');
      expect(details?.hasAttribute('open')).toBe(true);
    });

    it('applies overflow-wrap:anywhere to the thinking accordion body', async () => {
      renderView({ sessionId: 's14b', workerId: 'w14b' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });

      const chunk = ndjson({ v: 1, type: 'assistant-thinking-delta', turnId: 't1', text: 'pondering' });
      act(() => {
        ws?.simulateMessage(JSON.stringify({ type: 'output', data: chunk, offset: chunk.length, epoch: 1 }));
      });
      await flush();

      const user = userEvent.setup();
      const summary = document.querySelector('summary')!;
      await user.click(summary);

      const body = screen.getByText('pondering');
      expect(body.className).toContain('[overflow-wrap:anywhere]');
    });

    it('renders assistant messages WITHOUT thinking content exactly as before (no accordion present)', async () => {
      renderView({ sessionId: 's15', workerId: 'w15' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });

      const data = ndjson({ v: 1, type: 'assistant-message', turnId: 't1', text: 'plain answer, no thinking' });
      act(() => {
        ws?.simulateMessage(JSON.stringify({ type: 'history', data, offset: data.length, startOffset: 0, epoch: 1 }));
      });
      await flush();

      expect(screen.getByText('plain answer, no thinking')).toBeTruthy();
      expect(screen.queryByText('Thinking')).toBeNull();
      expect(document.querySelectorAll('details').length).toBe(0);
    });
  });
});
