import { describe, it, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test';
import { render, screen, cleanup, act, fireEvent, within } from '@testing-library/react';
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

/** True when `a` precedes `b` in document order -- used to assert chronological rendering across repeated element labels (e.g. multiple "Working" blocks) that text-index lookups can't disambiguate. */
function isBefore(a: Node, b: Node): boolean {
  return Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
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

  it('morphs Send into Cancel (not merely disabling Send) while a turn is active', async () => {
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

    // Send is replaced by Cancel in the same slot, not merely disabled.
    expect(screen.queryByText('Send')).toBeNull();
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

  it('clicking the morphed Cancel button sends embedded-cancel over the WebSocket', async () => {
    renderView({ sessionId: 's2c', workerId: 'w2c' });
    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
      ws?.simulateMessage(JSON.stringify({ type: 'activity', state: 'active' }));
    });
    await flush();

    const cancelButton = screen.getByText('Cancel') as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(cancelButton);
    });

    const sent = (ws!.send.mock.calls as string[][]).map((c) => JSON.parse(c[0]));
    expect(sent.some((m) => m.type === 'embedded-cancel')).toBe(true);
  });

  it('pressing Escape on the message input while a turn is active also sends embedded-cancel (onEscape wiring)', async () => {
    renderView({ sessionId: 's2d', workerId: 'w2d' });
    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
      ws?.simulateMessage(JSON.stringify({ type: 'activity', state: 'active' }));
    });
    await flush();

    const textarea = screen.getByPlaceholderText('Send message to worker... (Ctrl+Enter to send)');
    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Escape' });
    });

    const sent = (ws!.send.mock.calls as string[][]).map((c) => JSON.parse(c[0]));
    expect(sent.some((m) => m.type === 'embedded-cancel')).toBe(true);
  });

  it('pressing Escape while idle is a safe no-op (onEscape is unconditional but does not throw or misbehave)', async () => {
    renderView({ sessionId: 's2e', workerId: 'w2e' });
    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
    });

    const textarea = screen.getByPlaceholderText('Send message to worker... (Ctrl+Enter to send)');
    expect(() => {
      fireEvent.keyDown(textarea, { key: 'Escape' });
    }).not.toThrow();

    // No user-message or unexpected send should result from an idle-time Escape.
    const sent = (ws!.send.mock.calls as string[][] | undefined)?.map((c) => JSON.parse(c[0])) ?? [];
    expect(sent.some((m) => m.type === 'embedded-user-message')).toBe(false);
  });

  it('sends a message on Ctrl+Enter but keeps the draft until the server confirms it, then clears it (#1024)', async () => {
    renderView({ sessionId: 's4', workerId: 'w4' });
    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
    });

    const textarea = screen.getByPlaceholderText('Send message to worker... (Ctrl+Enter to send)') as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'hello agent' } });
    });
    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    });

    const sent = (ws!.send.mock.calls as string[][]).map((c) => JSON.parse(c[0])) as {
      type: string;
      text?: string;
      clientMessageId?: string;
    }[];
    const sentMessage = sent.find((m) => m.type === 'embedded-user-message');
    expect(sentMessage?.text).toBe('hello agent');
    // Issue #1117: the client always attaches a per-send correlation id.
    expect(sentMessage?.clientMessageId).toBeTruthy();
    // Not yet cleared -- the server hasn't confirmed the send. Clearing here
    // optimistically is exactly the bug #1024 reports.
    expect(textarea.value).toBe('hello agent');

    // Server echoes the message back, confirming it was accepted (correlated
    // by clientMessageId, Issue #1117).
    const data = ndjson({
      v: 1,
      type: 'user-message',
      id: 'u1',
      text: 'hello agent',
      clientMessageId: sentMessage?.clientMessageId,
    });
    await act(async () => {
      ws?.simulateMessage(JSON.stringify({ type: 'output', data, offset: data.length, epoch: 1 }));
    });
    await flush();

    expect(textarea.value).toBe('');
  });

  it('preserves the draft when the server rejects the send (TURN_IN_PROGRESS), letting the user retry without retyping (#1024)', async () => {
    renderView({ sessionId: 's4b', workerId: 'w4b' });
    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
    });

    const textarea = screen.getByPlaceholderText('Send message to worker... (Ctrl+Enter to send)') as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'hello agent' } });
    });
    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    });

    await act(async () => {
      ws?.simulateMessage(
        JSON.stringify({ type: 'error', message: 'turn in progress', code: 'TURN_IN_PROGRESS' }),
      );
    });
    await flush();

    // The draft must survive the rejection -- the user should not have to retype it.
    expect(textarea.value).toBe('hello agent');
    // The Send button must be usable again, not stuck disabled from the failed send's `sending` state.
    const sendButton = screen.getByText('Send') as HTMLButtonElement;
    expect(sendButton.disabled).toBe(false);
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

    it('renders the assistant message bubble at full width (no max-w- constraint) while the user bubble keeps its max-w-[80%] cap (#1095)', async () => {
      const { container } = renderView({ sessionId: 's12b', workerId: 'w12b' });
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

      const assistantBubble = container.querySelector('.memo-content');
      expect(assistantBubble).not.toBeNull();
      expect(assistantBubble?.className).not.toMatch(/max-w-/);

      const userBubble = screen.getByText('hi');
      expect(userBubble.className).toContain('max-w-[80%]');
    });

    it('keeps the wrap-enabling classes (.memo-content, min-w-0) on the assistant bubble for a long unbroken token at full width, with no max-w- constraint reintroduced (#1095)', async () => {
      const { container } = renderView({ sessionId: 's12c', workerId: 'w12c' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });

      // A single unbroken token (no spaces) long enough that, without
      // overflow-wrap:anywhere on `.memo-content` (styles.css) plus
      // min-w-0 on the flex item, it would force the bubble wider than
      // its container per the CSS Flexbox/Sizing spec (see the #1071
      // comment in styles.css). happy-dom does not load external
      // stylesheets, so this test cannot observe the actual wrap layout;
      // it locks in that the classes the CSS rule depends on remain
      // present once the max-w- cap is removed.
      const longToken = 'https://example.com/' + 'a'.repeat(300);
      const data = ndjson({ v: 1, type: 'assistant-message', turnId: 't1', text: longToken });
      act(() => {
        ws?.simulateMessage(JSON.stringify({ type: 'history', data, offset: data.length, startOffset: 0, epoch: 1 }));
      });
      await flush();

      const assistantBubble = container.querySelector('.memo-content');
      expect(assistantBubble).not.toBeNull();
      expect(assistantBubble?.className).toContain('min-w-0');
      expect(assistantBubble?.className).not.toMatch(/max-w-/);
      expect(assistantBubble?.textContent).toContain(longToken);
    });
  });

  describe('HTML/SVG preview toggle (#1097)', () => {
    it('renders a Preview toggle below a finalized assistant-message html fenced block', async () => {
      const { container } = renderView({ sessionId: 's25', workerId: 'w25' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });

      const markdown = ['```html', '<div>hi</div>', '```'].join('\n');
      const data = ndjson({ v: 1, type: 'assistant-message', turnId: 't1', text: markdown });
      act(() => {
        ws?.simulateMessage(JSON.stringify({ type: 'history', data, offset: data.length, startOffset: 0, epoch: 1 }));
      });
      await flush();

      expect(screen.getByText('Preview')).toBeTruthy();
      // Collapsed by default -- no iframe mounted yet.
      expect(container.querySelector('iframe')).toBeNull();
    });

    it('does NOT render a Preview toggle for a STREAMING assistant-message with the same fenced content (A1)', async () => {
      renderView({ sessionId: 's26', workerId: 'w26' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });

      // assistant-delta keeps the entry in the streaming state (no
      // assistant-message finalize event sent).
      const markdown = ['```html', '<div>hi</div>', '```'].join('\n');
      const chunk = ndjson({ v: 1, type: 'assistant-delta', turnId: 't1', text: markdown });
      act(() => {
        ws?.simulateMessage(JSON.stringify({ type: 'output', data: chunk, offset: chunk.length, epoch: 1 }));
      });
      await flush();

      expect(screen.queryByText('Preview')).toBeNull();
    });

    it('renders a Preview toggle for a mixed-case ```SVG fenced block', async () => {
      renderView({ sessionId: 's27', workerId: 'w27' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });

      const markdown = ['```SVG', '<svg><circle r="1"></circle></svg>', '```'].join('\n');
      const data = ndjson({ v: 1, type: 'assistant-message', turnId: 't1', text: markdown });
      act(() => {
        ws?.simulateMessage(JSON.stringify({ type: 'history', data, offset: data.length, startOffset: 0, epoch: 1 }));
      });
      await flush();

      expect(screen.getByText('Preview')).toBeTruthy();
    });

    it('does NOT render a Preview toggle for a fenced block with an unrelated language (javascript)', async () => {
      renderView({ sessionId: 's28', workerId: 'w28' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });

      const markdown = ['```javascript', "console.log('hi')", '```'].join('\n');
      const data = ndjson({ v: 1, type: 'assistant-message', turnId: 't1', text: markdown });
      act(() => {
        ws?.simulateMessage(JSON.stringify({ type: 'history', data, offset: data.length, startOffset: 0, epoch: 1 }));
      });
      await flush();

      expect(screen.queryByText('Preview')).toBeNull();
    });

    it('leaves an inline code span (no fence) unaffected -- no Preview toggle, unchanged rendering', async () => {
      const { container } = renderView({ sessionId: 's29', workerId: 'w29' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });

      const data = ndjson({ v: 1, type: 'assistant-message', turnId: 't1', text: 'see `inline code` here' });
      act(() => {
        ws?.simulateMessage(JSON.stringify({ type: 'history', data, offset: data.length, startOffset: 0, epoch: 1 }));
      });
      await flush();

      expect(screen.queryByText('Preview')).toBeNull();
      const code = container.querySelector('code');
      expect(code?.textContent).toBe('inline code');
      expect(container.querySelector('pre')).toBeNull();
    });
  });

  describe('Thinking inline under Working, no nested accordion (#1119, supersedes #1070)', () => {
    it('renders a thinking entry directly (no nested accordion) inside a collapsed-by-default Working accordion', async () => {
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

      // Thinking-only turn: no tool calls, so the outer summary shows just
      // the bare label (no "(N tool calls)" suffix).
      expect(screen.getByText('Working')).toBeTruthy();
      expect(screen.getByText('Thinking')).toBeTruthy();
      expect(screen.getByText('pondering deeply')).toBeTruthy();
      // Only the Working accordion itself is a <details> -- Thinking no
      // longer nests its own accordion, so there is exactly one collapsed
      // <details> for the whole group.
      const allDetails = Array.from(document.querySelectorAll('details'));
      expect(allDetails).toHaveLength(1);
      expect(allDetails[0]?.hasAttribute('open')).toBe(false);
    });

    it('clicking the outer Working summary directly reveals the Thinking content -- no second click required (#1119)', async () => {
      renderView({ sessionId: 's13b', workerId: 'w13b' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });

      const chunk = ndjson({ v: 1, type: 'assistant-thinking-delta', turnId: 't1', text: 'pondering deeply' });
      act(() => {
        ws?.simulateMessage(JSON.stringify({ type: 'output', data: chunk, offset: chunk.length, epoch: 1 }));
      });
      await flush();

      // A single click on the Working accordion's own summary is now
      // sufficient to reveal Thinking content directly -- there is no
      // second, nested accordion to open. Asserting exactly one <details>
      // exists (rather than just checking the outer one is open) is what
      // actually distinguishes this from the old nested-accordion shape,
      // where a second, still-closed inner <details> would also be present
      // at this point.
      const user = userEvent.setup();
      const outerSummary = document.querySelector('summary')!;
      await user.click(outerSummary);

      const allDetails = Array.from(document.querySelectorAll('details'));
      expect(allDetails).toHaveLength(1);
      expect(allDetails[0]?.hasAttribute('open')).toBe(true);
      expect(screen.getByText('pondering deeply')).toBeTruthy();
    });

    it('applies overflow-wrap:anywhere to the thinking content', async () => {
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
      const outerSummary = document.querySelector('summary')!;
      await user.click(outerSummary);

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
      expect(screen.queryByText('Working')).toBeNull();
      expect(document.querySelectorAll('details').length).toBe(0);
    });

    it('preserves the existing per-tool accordion when a run mixes thinking and a tool call -- only Thinking is flattened, Tool keeps its own nested accordion (#1119)', async () => {
      renderView({ sessionId: 's15b', workerId: 'w15b' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });

      const data = ndjson(
        { v: 1, type: 'assistant-thinking-delta', turnId: 't1', text: 'pondering the tool choice' },
        { v: 1, type: 'tool-call', turnId: 't1', callId: 'c1', name: 'run_process', args: { cmd: 'ls' } },
        { v: 1, type: 'tool-result', turnId: 't1', callId: 'c1', ok: true, result: 'done' },
      );
      act(() => {
        ws?.simulateMessage(JSON.stringify({ type: 'history', data, offset: data.length, startOffset: 0, epoch: 1 }));
      });
      await flush();

      // Exactly two <details>: the outer Working accordion and the Tool
      // card's own nested accordion. Thinking contributes zero -- its
      // content sits directly in the Working body as a plain block.
      const allDetails = Array.from(document.querySelectorAll('details'));
      expect(allDetails).toHaveLength(2);
      expect(allDetails.every((d) => !d.hasAttribute('open'))).toBe(true);

      const user = userEvent.setup();
      const outerSummary = document.querySelector('summary')!;
      await user.click(outerSummary);

      // Opening Working alone is enough to see the thinking text and the
      // Tool row's summary (name + running/result state) -- but the Tool
      // accordion's own body (the JSON args) stays collapsed until its own
      // summary is clicked, preserving existing per-tool toggle behavior.
      expect(screen.getByText('pondering the tool choice')).toBeTruthy();
      expect(screen.getByText('run_process')).toBeTruthy();
      const [outerDetailsAfter, toolDetailsAfter] = Array.from(document.querySelectorAll('details'));
      expect(outerDetailsAfter?.hasAttribute('open')).toBe(true);
      expect(toolDetailsAfter?.hasAttribute('open')).toBe(false);
    });
  });

  describe('Unified Working accordion (#1088)', () => {
    it('groups a multi-iteration turn (thinking -> tools -> thinking -> tools -> final) into TWO Working accordions, interleaved chronologically around the intermediate narration (#1092)', async () => {
      const { container } = renderView({ sessionId: 's16', workerId: 'w16' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });

      const data = ndjson(
        { v: 1, type: 'assistant-thinking-delta', turnId: 't1', text: 'first-round-thinking' },
        { v: 1, type: 'tool-call', turnId: 't1', callId: 'c1', name: 'first_tool', args: {} },
        { v: 1, type: 'tool-result', turnId: 't1', callId: 'c1', ok: true, result: 'first-tool-result' },
        { v: 1, type: 'assistant-message', turnId: 't1', text: 'intermediate note' },
        { v: 1, type: 'assistant-thinking-delta', turnId: 't1', text: 'second-round-thinking' },
        { v: 1, type: 'tool-call', turnId: 't1', callId: 'c2', name: 'second_tool', args: {} },
        { v: 1, type: 'tool-result', turnId: 't1', callId: 'c2', ok: true, result: 'second-tool-result' },
        { v: 1, type: 'assistant-message', turnId: 't1', text: 'final answer' },
      );
      act(() => {
        ws?.simulateMessage(JSON.stringify({ type: 'history', data, offset: data.length, startOffset: 0, epoch: 1 }));
      });
      await flush();

      // The non-empty intermediate assistant-message splits the turn's tool
      // activity into two separate runs -- each iteration gets its own
      // Working block, not one block for the whole turn.
      const workingLabels = screen.getAllByText('Working (1 tool call)');
      expect(workingLabels).toHaveLength(2);

      // Chronological order preserved: block 1 -> intermediate note -> block
      // 2 -> final answer, matching raw-entries arrival order. Text indices
      // can't disambiguate the two identical "Working (1 tool call)" labels,
      // so compare DOM position directly via compareDocumentPosition.
      const text = container.textContent ?? '';
      const idxIntermediate = text.indexOf('intermediate note');
      const idxFinal = text.indexOf('final answer');
      expect(idxIntermediate).toBeGreaterThanOrEqual(0);
      expect(idxFinal).toBeGreaterThan(idxIntermediate);

      const [firstBlock, secondBlock] = workingLabels;
      const intermediateNode = screen.getByText('intermediate note');
      expect(isBefore(firstBlock, intermediateNode)).toBe(true);
      expect(isBefore(intermediateNode, secondBlock)).toBe(true);
    });

    it('renders the Working accordion collapsed by default', async () => {
      renderView({ sessionId: 's17', workerId: 'w17' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });

      const data = ndjson(
        { v: 1, type: 'tool-call', turnId: 't1', callId: 'c1', name: 'run_process', args: { cmd: 'ls' } },
        { v: 1, type: 'tool-result', turnId: 't1', callId: 'c1', ok: true, result: 'done' },
      );
      act(() => {
        ws?.simulateMessage(JSON.stringify({ type: 'history', data, offset: data.length, startOffset: 0, epoch: 1 }));
      });
      await flush();

      const details = document.querySelector('details');
      expect(details?.hasAttribute('open')).toBe(false);
    });

    it('keeps a user-expanded Working accordion open when more entries are appended to the same run (A3\' regression: keyed by the run\'s first-entry key, not turnId)', async () => {
      renderView({ sessionId: 's18', workerId: 'w18' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });

      const firstChunk = ndjson({ v: 1, type: 'assistant-thinking-delta', turnId: 't1', text: 'thinking one' });
      act(() => {
        ws?.simulateMessage(JSON.stringify({ type: 'output', data: firstChunk, offset: firstChunk.length, epoch: 1 }));
      });
      await flush();

      const user = userEvent.setup();
      const outerSummary = document.querySelector('summary')!;
      await user.click(outerSummary);

      let details = document.querySelector('details');
      expect(details?.hasAttribute('open')).toBe(true);

      // This tool-call belongs to the SAME turnId and follows immediately
      // (no outside entry in between), so it extends the currently-open run
      // rather than starting a new one -- the run's first entry (the
      // thinking entry above) stays the same, so the React key derived from
      // it (entries[0].key) is unchanged across this re-render, which is
      // what keeps the <details> DOM node -- and its open state -- alive.
      const secondChunk = ndjson({ v: 1, type: 'tool-call', turnId: 't1', callId: 'c1', name: 'run_process', args: {} });
      act(() => {
        ws?.simulateMessage(
          JSON.stringify({ type: 'output', data: secondChunk, offset: firstChunk.length + secondChunk.length, epoch: 1 }),
        );
      });
      await flush();

      details = document.querySelector('details');
      expect(details?.hasAttribute('open')).toBe(true);
      expect(screen.getByText('Working (1 tool call)')).toBeTruthy();
    });

    it('keeps errors, fatal, exited, and final assistant messages outside any accordion', async () => {
      renderView({ sessionId: 's19', workerId: 'w19' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });

      const data = ndjson(
        { v: 1, type: 'assistant-thinking-delta', turnId: 't1', text: 'thinking before error' },
        { v: 1, type: 'turn-error', turnId: 't1', message: 'boom error' },
        { v: 1, type: 'assistant-message', turnId: 't2', text: 'a final message' },
      );
      act(() => {
        ws?.simulateMessage(JSON.stringify({ type: 'history', data, offset: data.length, startOffset: 0, epoch: 1 }));
      });
      await flush();

      const errorNode = screen.getByText(/boom error/);
      const finalNode = screen.getByText('a final message');
      const allDetails = Array.from(document.querySelectorAll('details'));
      expect(allDetails.every((d) => !d.contains(errorNode))).toBe(true);
      expect(allDetails.every((d) => !d.contains(finalNode))).toBe(true);
    });

    it('keeps an intermediate assistant-message (mid-turn, between two tool rounds) outside any accordion, and splits the two tool rounds into separate Working blocks (#1092)', async () => {
      renderView({ sessionId: 's20', workerId: 'w20' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });

      const data = ndjson(
        { v: 1, type: 'tool-call', turnId: 't1', callId: 'c1', name: 'first_tool', args: {} },
        { v: 1, type: 'tool-result', turnId: 't1', callId: 'c1', ok: true, result: 'ok1' },
        { v: 1, type: 'assistant-message', turnId: 't1', text: 'mid-turn placeholder text' },
        { v: 1, type: 'tool-call', turnId: 't1', callId: 'c2', name: 'second_tool', args: {} },
        { v: 1, type: 'tool-result', turnId: 't1', callId: 'c2', ok: true, result: 'ok2' },
      );
      act(() => {
        ws?.simulateMessage(JSON.stringify({ type: 'history', data, offset: data.length, startOffset: 0, epoch: 1 }));
      });
      await flush();

      // The intermediate message stays outside every accordion regardless of
      // how many Working blocks the turn ends up producing.
      const intermediateNode = screen.getByText('mid-turn placeholder text');
      const allDetails = Array.from(document.querySelectorAll('details'));
      expect(allDetails.every((d) => !d.contains(intermediateNode))).toBe(true);
      // The non-empty intermediate message splits the two tool rounds into
      // two separate Working blocks, one tool call each.
      expect(screen.getAllByText('Working (1 tool call)')).toHaveLength(2);
    });

    it('produces equivalent visible output for the same event sequence via replay (one history message) and live (sequential output messages), including the multi-block case (#1092)', async () => {
      const events = [
        { v: 1, type: 'assistant-thinking-delta', turnId: 't1', text: 'thinking' },
        { v: 1, type: 'tool-call', turnId: 't1', callId: 'c1', name: 'run_process', args: { cmd: 'ls' } },
        { v: 1, type: 'tool-result', turnId: 't1', callId: 'c1', ok: true, result: 'done' },
        { v: 1, type: 'assistant-message', turnId: 't1', text: 'intermediate note' },
        { v: 1, type: 'tool-call', turnId: 't1', callId: 'c2', name: 'run_process_2', args: { cmd: 'ls -la' } },
        { v: 1, type: 'tool-result', turnId: 't1', callId: 'c2', ok: true, result: 'done again' },
        { v: 1, type: 'assistant-message', turnId: 't1', text: 'final answer' },
      ];

      // (a) Replay: one history message.
      const replayView = renderView({ sessionId: 's21a', workerId: 'w21a' });
      const replayWs = MockWebSocket.getLastInstance();
      act(() => {
        replayWs?.simulateOpen();
      });
      const replayData = ndjson(...events);
      act(() => {
        replayWs?.simulateMessage(
          JSON.stringify({ type: 'history', data: replayData, offset: replayData.length, startOffset: 0, epoch: 1 }),
        );
      });
      await flush();

      // (b) Live: sequential output messages, same order.
      const liveView = renderView({ sessionId: 's21b', workerId: 'w21b' });
      const liveWs = MockWebSocket.getLastInstance();
      act(() => {
        liveWs?.simulateOpen();
      });
      let offset = 0;
      for (const event of events) {
        const chunk = ndjson(event);
        offset += chunk.length;
        act(() => {
          liveWs?.simulateMessage(JSON.stringify({ type: 'output', data: chunk, offset, epoch: 1 }));
        });
        await flush();
      }

      // Both default-collapsed, so only the Working summary label+count and
      // the outside message text are visible in either mode. Query scoped
      // explicitly via `within(container)` -- RenderResult's own query
      // methods are bound to `document.body` by default, so with BOTH views
      // mounted simultaneously (no cleanup() between them) an unscoped query
      // would see both views' content at once.
      const replayScope = within(replayView.container);
      const liveScope = within(liveView.container);
      // Two Working blocks (split by the intermediate note), one tool call each.
      expect(replayScope.getAllByText('Working (1 tool call)')).toHaveLength(2);
      expect(liveScope.getAllByText('Working (1 tool call)')).toHaveLength(2);
      expect(replayScope.getByText('intermediate note')).toBeTruthy();
      expect(liveScope.getByText('intermediate note')).toBeTruthy();
      expect(replayScope.getByText('final answer')).toBeTruthy();
      expect(liveScope.getByText('final answer')).toBeTruthy();
    });

    it('does not render a finalized-empty assistant-message as a chat bubble (#1092)', async () => {
      renderView({ sessionId: 's22', workerId: 'w22' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });

      const data = ndjson(
        { v: 1, type: 'tool-call', turnId: 't1', callId: 'c1', name: 'first_tool', args: {} },
        { v: 1, type: 'tool-result', turnId: 't1', callId: 'c1', ok: true, result: 'ok1' },
        // An iteration that only emitted tool calls finalizes with empty text.
        { v: 1, type: 'assistant-message', turnId: 't1', text: '' },
      );
      act(() => {
        ws?.simulateMessage(JSON.stringify({ type: 'history', data, offset: data.length, startOffset: 0, epoch: 1 }));
      });
      await flush();

      // Only the Working accordion's own bubble wrapper should exist -- no
      // second, empty chat bubble for the finalized-empty assistant-message.
      expect(screen.getByText('Working (1 tool call)')).toBeTruthy();
      expect(document.querySelectorAll('.memo-content').length).toBe(0);
    });

    it('merges two groupable runs into ONE Working block when they are separated only by a finalized-empty assistant-message (suppress-then-group ordering, #1092)', async () => {
      renderView({ sessionId: 's23', workerId: 'w23' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });

      const data = ndjson(
        { v: 1, type: 'tool-call', turnId: 't1', callId: 'c1', name: 'first_tool', args: {} },
        { v: 1, type: 'tool-result', turnId: 't1', callId: 'c1', ok: true, result: 'ok1' },
        // Finalized-empty assistant-message: not meaningful content, must be
        // suppressed BEFORE grouping so it does not fragment the run.
        { v: 1, type: 'assistant-message', turnId: 't1', text: '   ' },
        { v: 1, type: 'tool-call', turnId: 't1', callId: 'c2', name: 'second_tool', args: {} },
        { v: 1, type: 'tool-result', turnId: 't1', callId: 'c2', ok: true, result: 'ok2' },
      );
      act(() => {
        ws?.simulateMessage(JSON.stringify({ type: 'history', data, offset: data.length, startOffset: 0, epoch: 1 }));
      });
      await flush();

      // If suppression ran AFTER grouping, this would produce two separate
      // one-tool-call blocks (the empty message would still act as a
      // fragmenting boundary at grouping time). Suppress-then-group merges
      // them into a single two-tool-call block instead.
      expect(screen.getAllByText(/^Working/)).toHaveLength(1);
      expect(screen.getByText('Working (2 tool calls)')).toBeTruthy();
      expect(document.querySelectorAll('.memo-content').length).toBe(0);
    });

    it('still renders a streaming-empty assistant-message (the typing-indicator bubble), unlike a finalized-empty one (#1092)', async () => {
      renderView({ sessionId: 's24', workerId: 'w24' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });

      // An `assistant-delta` with empty text opens a streaming assistant
      // entry whose text is still empty -- this must render its bubble
      // (with the typing-cursor pulse) rather than being suppressed like a
      // finalized-empty entry.
      const chunk = ndjson({ v: 1, type: 'assistant-delta', turnId: 't1', text: '' });
      act(() => {
        ws?.simulateMessage(JSON.stringify({ type: 'output', data: chunk, offset: chunk.length, epoch: 1 }));
      });
      await flush();

      const bubbles = document.querySelectorAll('.memo-content');
      expect(bubbles.length).toBe(1);
      // The typing-cursor pulse indicator lives inside the streaming bubble.
      expect(bubbles[0].querySelector('.animate-pulse')).toBeTruthy();
    });
  });

  describe('Copy markdown button (#1118)', () => {
    // Preserve the original clipboard descriptor so we can restore it per-test.
    // happy-dom provides a real clipboard implementation; we swap it out for a
    // jest-mock so we can assert on `writeText` calls without touching the OS.
    const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(navigator),
      'clipboard',
    );

    // Fresh writeText mock per test so counts / args do not bleed across tests.
    let writeTextMock: ReturnType<typeof mock>;

    function installClipboardMock() {
      writeTextMock = mock(() => Promise.resolve());
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: writeTextMock },
        writable: true,
        configurable: true,
      });
    }

    function restoreClipboard() {
      Reflect.deleteProperty(navigator, 'clipboard');
      if (originalClipboardDescriptor && !('clipboard' in navigator)) {
        Object.defineProperty(Object.getPrototypeOf(navigator), 'clipboard', originalClipboardDescriptor);
      }
    }

    // happy-dom does not implement `window.isSecureContext` (it is
    // `undefined`, i.e. falsy) regardless of the mocked `http://localhost`
    // location above. Real browsers treat `http://localhost` as a secure
    // context, so we stub `true` here to match real-browser behavior for
    // every test in this block except the #1159 non-secure-context tests,
    // which explicitly override it back to a falsy value.
    const originalIsSecureContextDescriptor = Object.getOwnPropertyDescriptor(window, 'isSecureContext');

    function installSecureContext() {
      Object.defineProperty(window, 'isSecureContext', { value: true, writable: true, configurable: true });
    }

    function restoreSecureContext() {
      if (originalIsSecureContextDescriptor) {
        Object.defineProperty(window, 'isSecureContext', originalIsSecureContextDescriptor);
      } else {
        Reflect.deleteProperty(window, 'isSecureContext');
      }
    }

    beforeEach(() => {
      installClipboardMock();
      installSecureContext();
    });

    afterEach(() => {
      restoreClipboard();
      restoreSecureContext();
    });

    async function renderWithAssistantMessage(sessionId: string, workerId: string, text: string) {
      renderView({ sessionId, workerId });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });
      const data = ndjson(
        { v: 1, type: 'user-message', id: 'u1', text: 'hi' },
        { v: 1, type: 'assistant-message', turnId: 't1', text },
      );
      act(() => {
        ws?.simulateMessage(JSON.stringify({ type: 'history', data, offset: data.length, startOffset: 0, epoch: 1 }));
      });
      await flush();
    }

    it('renders a copy-markdown button on an assistant message bubble', async () => {
      await renderWithAssistantMessage('s30', 'w30', '**hello** world');

      expect(screen.getByRole('button', { name: 'Copy as markdown' })).toBeTruthy();
    });

    it('does not render a copy-markdown button on a user message bubble', async () => {
      renderView({ sessionId: 's31', workerId: 'w31' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });
      const data = ndjson({ v: 1, type: 'user-message', id: 'u1', text: 'only a user message' });
      act(() => {
        ws?.simulateMessage(JSON.stringify({ type: 'history', data, offset: data.length, startOffset: 0, epoch: 1 }));
      });
      await flush();

      expect(screen.getByText('only a user message')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Copy as markdown' })).toBeNull();
    });

    it('does NOT render a copy-markdown button for a STREAMING assistant-message (#1124)', async () => {
      renderView({ sessionId: 's30b', workerId: 'w30b' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });

      // assistant-delta keeps the entry in the streaming state (no
      // assistant-message finalize event sent), mirroring the Preview-toggle
      // streaming test above (A1).
      const chunk = ndjson({ v: 1, type: 'assistant-delta', turnId: 't1', text: 'partial mark' });
      act(() => {
        ws?.simulateMessage(JSON.stringify({ type: 'output', data: chunk, offset: chunk.length, epoch: 1 }));
      });
      await flush();

      expect(screen.getByText('partial mark')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Copy as markdown' })).toBeNull();
    });

    it('renders a copy-markdown button once a STREAMING assistant-message finalizes (#1124)', async () => {
      renderView({ sessionId: 's30c', workerId: 'w30c' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });

      const chunk = ndjson({ v: 1, type: 'assistant-delta', turnId: 't1', text: 'partial mark' });
      act(() => {
        ws?.simulateMessage(JSON.stringify({ type: 'output', data: chunk, offset: chunk.length, epoch: 1 }));
      });
      await flush();
      expect(screen.queryByRole('button', { name: 'Copy as markdown' })).toBeNull();

      const finalize = ndjson({ v: 1, type: 'assistant-message', turnId: 't1', text: 'partial mark done' });
      act(() => {
        ws?.simulateMessage(
          JSON.stringify({ type: 'output', data: finalize, offset: chunk.length + finalize.length, epoch: 1 }),
        );
      });
      await flush();

      expect(screen.getByRole('button', { name: 'Copy as markdown' })).toBeTruthy();
    });

    it('copies the raw markdown text (not rendered HTML) to the clipboard on click', async () => {
      const markdown = '# Heading\n\n**bold** and `code`';
      await renderWithAssistantMessage('s32', 'w32', markdown);

      const button = screen.getByRole('button', { name: 'Copy as markdown' });
      // We use `fireEvent` rather than `userEvent` because `userEvent.setup()`
      // installs its own clipboard stub via a `navigator.clipboard` getter,
      // which shadows the mock installed above. `fireEvent.click` bypasses
      // that setup and dispatches the click directly; the extra
      // `await Promise.resolve()` yields so the async click handler's
      // `await navigator.clipboard.writeText` microtask resolves before we
      // assert (mirrors the McpInstallSection copy-button test pattern).
      await act(async () => {
        fireEvent.click(button);
        await Promise.resolve();
      });

      expect(writeTextMock).toHaveBeenCalledTimes(1);
      expect(writeTextMock.mock.calls[0]?.[0]).toBe(markdown);
    });

    it('switches to a Check icon + "Copied!" tooltip after clicking, then reverts to idle after 1.5s', async () => {
      await renderWithAssistantMessage('s33', 'w33', 'copy me');

      const button = screen.getByRole('button', { name: 'Copy as markdown' });
      await act(async () => {
        fireEvent.click(button);
        await Promise.resolve();
      });

      const copiedButton = screen.getByRole('button', { name: 'Copied!' });
      expect(copiedButton.title).toBe('Copied!');
      expect(screen.queryByRole('button', { name: 'Copy as markdown' })).toBeNull();

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1600));
      });

      expect(screen.getByRole('button', { name: 'Copy as markdown' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Copied!' })).toBeNull();
    });

    it('a second click before the first feedback window elapses keeps "Copied!" visible until the SECOND click\'s own 1.5s window elapses (rapid-click timer reset, CodeRabbit #1121)', async () => {
      await renderWithAssistantMessage('s34', 'w34', 'copy me twice');
      const button = screen.getByRole('button', { name: 'Copy as markdown' });

      await act(async () => {
        fireEvent.click(button);
        await Promise.resolve();
      });
      expect(screen.getByRole('button', { name: 'Copied!' })).toBeTruthy();

      // 800ms after the FIRST click -- well under the first click's own 1.5s
      // window, so this alone proves nothing about timer-reset behavior yet.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 800));
      });
      expect(screen.getByRole('button', { name: 'Copied!' })).toBeTruthy();

      // Second click while still in the "Copied!" state must clear the first
      // click's pending revert timer and arm a fresh one.
      await act(async () => {
        fireEvent.click(button);
        await Promise.resolve();
      });

      // 800ms after the SECOND click = 1600ms after the FIRST click. Without
      // the timer-reset fix, the first click's timer would have fired at
      // 1500ms and already reverted the button by this point.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 800));
      });
      expect(screen.getByRole('button', { name: 'Copied!' })).toBeTruthy();

      // 800ms further (1600ms after the SECOND click) -- the second click's
      // own timer has now elapsed and the button reverts.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 800));
      });
      expect(screen.getByRole('button', { name: 'Copy as markdown' })).toBeTruthy();
    });

    it('clears the pending revert timeout on unmount instead of leaking a scheduled setState (CodeRabbit #1121)', async () => {
      const view = renderView({ sessionId: 's35', workerId: 'w35' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });
      const data = ndjson(
        { v: 1, type: 'user-message', id: 'u1', text: 'hi' },
        { v: 1, type: 'assistant-message', turnId: 't1', text: 'copy me' },
      );
      act(() => {
        ws?.simulateMessage(JSON.stringify({ type: 'history', data, offset: data.length, startOffset: 0, epoch: 1 }));
      });
      await flush();

      // Spy on the real global timer functions (pass-through, not mocked
      // implementations) rather than switching to fake timers -- sibling
      // subsystems mounted alongside this component (TanStack Query's
      // garbage-collection timer, the mock WebSocket) schedule their OWN
      // timers on unmount, which would pollute a raw vi.getTimerCount()
      // delta. Identifying our button's specific revert timer by its
      // COPY_MARKDOWN_FEEDBACK_MS (1500ms) delay avoids that ambiguity.
      const setTimeoutSpy = spyOn(globalThis, 'setTimeout');
      const clearTimeoutSpy = spyOn(globalThis, 'clearTimeout');
      try {
        const button = screen.getByRole('button', { name: 'Copy as markdown' });
        await act(async () => {
          fireEvent.click(button);
          await Promise.resolve();
        });
        expect(screen.getByRole('button', { name: 'Copied!' })).toBeTruthy();

        const revertTimerCallIndex = setTimeoutSpy.mock.calls.findIndex((call) => call[1] === 1500);
        expect(revertTimerCallIndex).toBeGreaterThanOrEqual(0);
        const revertTimerId = setTimeoutSpy.mock.results[revertTimerCallIndex]?.value;
        expect(revertTimerId).toBeTruthy();

        view.unmount();

        // Unmount's effect cleanup must clear exactly this revert timer --
        // not merely leave it dangling to fire a setState against an
        // unmounted component later.
        expect(clearTimeoutSpy.mock.calls.some((call) => call[0] === revertTimerId)).toBe(true);
      } finally {
        setTimeoutSpy.mockRestore();
        clearTimeoutSpy.mockRestore();
      }
    });

    it('logs and leaves the button in the idle "Copy as markdown" state when clipboard.writeText rejects, instead of throwing an unhandled rejection (CodeRabbit #1121)', async () => {
      const consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
      try {
        writeTextMock.mockRejectedValueOnce(new Error('document not focused'));
        await renderWithAssistantMessage('s36', 'w36', 'copy me');

        const button = screen.getByRole('button', { name: 'Copy as markdown' });
        await act(async () => {
          fireEvent.click(button);
          await Promise.resolve();
          await Promise.resolve();
        });

        expect(consoleErrorSpy).toHaveBeenCalled();
        expect(screen.getByRole('button', { name: 'Copy as markdown' })).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Copied!' })).toBeNull();
      } finally {
        consoleErrorSpy.mockRestore();
      }
    });

    // navigator.clipboard is only defined in a secure context (HTTPS or
    // localhost/127.0.0.1). Dev-server access over plain-HTTP LAN
    // (e.g. http://192.168.1.12:5173/) leaves it undefined, so the
    // primary path must fall back to the legacy execCommand('copy')
    // technique instead of silently failing (#1159).
    function installUndefinedClipboard() {
      Object.defineProperty(navigator, 'clipboard', {
        value: undefined,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(window, 'isSecureContext', { value: false, writable: true, configurable: true });
    }

    it('falls back to document.execCommand("copy") and shows "Copied!" when navigator.clipboard is unavailable (non-secure context, #1159)', async () => {
      installUndefinedClipboard();
      const execCommandMock = mock(() => true);
      // happy-dom does not implement execCommand, so assign it directly
      // rather than spyOn-wrapping a nonexistent method.
      Object.defineProperty(document, 'execCommand', {
        value: execCommandMock,
        configurable: true,
      });
      try {
        await renderWithAssistantMessage('s37', 'w37', 'copy me via fallback');

        const button = screen.getByRole('button', { name: 'Copy as markdown' });
        await act(async () => {
          fireEvent.click(button);
          await Promise.resolve();
        });

        expect(execCommandMock).toHaveBeenCalledWith('copy');
        expect(writeTextMock).not.toHaveBeenCalled();
        expect(screen.getByRole('button', { name: 'Copied!' })).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Copy as markdown' })).toBeNull();
      } finally {
        Reflect.deleteProperty(document, 'execCommand');
      }
    });

    it('logs and leaves the button in the idle "Copy as markdown" state when BOTH the clipboard API and the execCommand fallback fail (#1159)', async () => {
      const consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
      installUndefinedClipboard();
      const execCommandMock = mock(() => false);
      Object.defineProperty(document, 'execCommand', {
        value: execCommandMock,
        configurable: true,
      });
      try {
        await renderWithAssistantMessage('s38', 'w38', 'copy me but fail');

        const button = screen.getByRole('button', { name: 'Copy as markdown' });
        await act(async () => {
          fireEvent.click(button);
          await Promise.resolve();
          await Promise.resolve();
        });

        expect(execCommandMock).toHaveBeenCalledWith('copy');
        expect(consoleErrorSpy).toHaveBeenCalled();
        expect(screen.getByRole('button', { name: 'Copy as markdown' })).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Copied!' })).toBeNull();
      } finally {
        Reflect.deleteProperty(document, 'execCommand');
        consoleErrorSpy.mockRestore();
      }
    });
  });
});
