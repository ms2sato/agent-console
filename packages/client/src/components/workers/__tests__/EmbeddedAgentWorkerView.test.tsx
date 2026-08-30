import { describe, it, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test';
import { render, screen, cleanup, act, fireEvent, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  EmbeddedAgentWorkerView,
  formatTokenCount,
  formatCompactionBoundaryLabel,
} from '../EmbeddedAgentWorkerView';
import { MockWebSocket, installMockWebSocket } from '../../../test/mock-websocket';
import { _resetEmbeddedAgentWorkers } from '../embedded-agent-store';
import type { RestorePreservation } from '@agent-console/shared';

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

/** Builds a fetch stub that also serves `/api/embedded-agents` with the given registry (Context Handoff Phase A: `EmbeddedAgentWorkerView` looks up its worker's definition via `useEmbeddedAgents`). */
function makeEmbeddedViewFetch(embeddedAgents: unknown[] = []) {
  return (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/api/skills')) return Promise.resolve(jsonResponse({ skills: [] }));
    if (url.endsWith('/api/message-templates')) return Promise.resolve(jsonResponse({ templates: [] }));
    if (url.endsWith('/api/embedded-agents')) return Promise.resolve(jsonResponse({ embeddedAgents }));
    return Promise.resolve(new Response('null', { status: 404 }));
  };
}

const embeddedViewFetch = makeEmbeddedViewFetch();

/** Fixture `EmbeddedAgentDefinition` with Context Handoff (Phase A) fields set to easy-to-reason-about values (soft 50%, hard 80% of a 1000-token window). */
function embeddedAgentFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ea-1',
    name: 'Test Embedded Agent',
    engine: 'openai-api',
    provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b' },
    isBuiltIn: false,
    createdBy: 'user-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    contextWindowTokens: 1000,
    compaction: { threshold: 0.8 },
    ...overrides,
  };
}

/** Render EmbeddedAgentWorkerView with the QueryClientProvider MessagePanel needs. */
function renderView(props: {
  sessionId: string;
  workerId: string;
  embeddedAgentId?: string;
  autoCompaction?: boolean;
}) {
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

    // The persistent amber notice text ("Conversation is restored...") stays
    // -- only the removed per-view status row's exact labels are asserted absent.
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

  it('renders the persistent transcript-restore note once the worker definition resolves to openai-api', async () => {
    globalThis.fetch = Object.assign(mock(makeEmbeddedViewFetch([embeddedAgentFixture()])), { preconnect: () => {} });
    renderView({ sessionId: 's1', workerId: 'w1', embeddedAgentId: 'ea-1' });
    await act(async () => {
      await flush();
    });

    expect(
      screen.getByText(/Conversation is restored automatically after a worker or server restart/i),
    ).toBeTruthy();
  });

  it('always renders the experimental-agent notice', () => {
    renderView({ sessionId: 's1c', workerId: 'w1c' });

    expect(screen.getByText('This is an experimental Embedded Agent.')).toBeTruthy();
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

  describe('internal notifications (Issue #1351)', () => {
    it('renders a system-originated notification as a muted collapsed row (NOT a blue bubble), collapsed by default, while a genuinely typed user-message in the SAME transcript keeps its blue bubble unchanged and fully visible', async () => {
      const { container } = renderView({ sessionId: 's-notif-1', workerId: 'w-notif-1' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });

      const data = ndjson(
        {
          v: 1,
          type: 'user-message',
          id: 'u1',
          text:
            '[internal:message] timestamp=2026-08-18T00:00:00.000Z source=session from=other-session summary="Message from session X" path=/tmp/foo intent=triage\n[Reply Instructions]\nReply via send_session_message.',
          notification: { kind: 'internal-message', summary: 'Message from session X' },
        },
        { v: 1, type: 'user-message', id: 'u2', text: 'a genuinely typed user message' },
        { v: 1, type: 'assistant-message', turnId: 't1', text: 'an assistant reply' },
      );
      act(() => {
        ws?.simulateMessage(JSON.stringify({ type: 'history', data, offset: data.length, startOffset: 0, epoch: 1 }));
      });
      await flush();

      // Bug-polarity assertion: exactly ONE blue bubble exists, and it belongs
      // to the genuinely typed message -- the notification row does not use
      // the bubble treatment anywhere in its subtree.
      const blueBubbles = container.querySelectorAll('.bg-blue-600\\/80');
      expect(blueBubbles).toHaveLength(1);
      expect(blueBubbles[0].textContent).toBe('a genuinely typed user message');

      // The notification row is rendered (humanized label + summary preview),
      // collapsed by default -- <details>/<summary> is the same closed-by-default
      // mechanism as the context-handoff/restore-repair rows (see those tests):
      // native `details.open` is the collapse signal, not DOM text absence
      // (happy-dom keeps closed <details> content in the tree, matching real
      // browser semantics where it exists but has no layout box).
      expect(screen.getByText('Message')).toBeTruthy();
      const summary = screen.getByText('Message from session X').closest('summary')!;
      const details = summary.closest('details') as HTMLDetailsElement;
      expect(details).toBeTruthy();
      expect(details.open).toBe(false);

      // The plain user-message stays completely unchanged: immediately visible, full text.
      expect(screen.getByText('a genuinely typed user message')).toBeTruthy();
    });

    it('expands to reveal the full raw text on click, and stays collapsed until then', async () => {
      renderView({ sessionId: 's-notif-2', workerId: 'w-notif-2' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });

      const data = ndjson({
        v: 1,
        type: 'user-message',
        id: 'u1',
        text:
          '[internal:message] timestamp=2026-08-18T00:00:00.000Z source=session from=other-session summary="short summary"\n[Reply Instructions]\nFull raw notification body only visible when expanded.',
        notification: { kind: 'internal-message', summary: 'short summary' },
      });
      act(() => {
        ws?.simulateMessage(JSON.stringify({ type: 'history', data, offset: data.length, startOffset: 0, epoch: 1 }));
      });
      await flush();

      const summary = screen.getByText('short summary').closest('summary')!;
      const details = summary.closest('details') as HTMLDetailsElement;
      // Collapsed by default -- native `details.open` is the collapse signal
      // here (see the context-handoff/restore-repair precedents above): a
      // closed <details>'s content stays in the DOM tree (no layout box,
      // same as a real browser) rather than being removed, so `details.open`
      // is what this suite asserts against, not DOM-text absence.
      expect(details.open).toBe(false);

      fireEvent.click(summary);

      expect(details.open).toBe(true);
      expect(screen.getByText(/Full raw notification body only visible when expanded/)).toBeTruthy();
    });

    it('falls back to a capped first-line preview of the raw text for a notification kind with no `summary` field on the wire', async () => {
      renderView({ sessionId: 's-notif-3', workerId: 'w-notif-3' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });

      const data = ndjson({
        v: 1,
        type: 'user-message',
        id: 'u1',
        text: '[internal:timer] timestamp=2026-08-18T00:00:00.000Z name=my-timer',
        notification: { kind: 'internal-timer' },
      });
      act(() => {
        ws?.simulateMessage(JSON.stringify({ type: 'history', data, offset: data.length, startOffset: 0, epoch: 1 }));
      });
      await flush();

      expect(screen.getByText('Timer')).toBeTruthy();
      // The fallback preview is derived from entry.text (its first line), not
      // a literal "undefined" placeholder for the absent summary field. Scope
      // to the <summary> element specifically -- for this single-line-text
      // fixture the preview and the (also-present, closed) expanded-body copy
      // share identical text, so an unscoped screen.getByText would be
      // ambiguous.
      const summary = document.querySelector('summary')!;
      expect(summary.textContent).not.toContain('undefined');
      expect(summary.textContent).toContain(
        '[internal:timer] timestamp=2026-08-18T00:00:00.000Z name=my-timer',
      );
    });
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

  it('renders an exited row as a plain historical fact with NO per-row affordance, and a single Restart action OUTSIDE the transcript driven by current state', async () => {
    // R1 (#1455): the row itself must carry zero interactive affordances --
    // not "only the last row keeps a button", the row NEVER does. The
    // Restart action lives as a sibling of the scrollable transcript list,
    // outside its `.overflow-y-auto` container.
    const { container } = renderView({ sessionId: 's7', workerId: 'w7' });
    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
    });

    const data = ndjson({ v: 1, type: 'exited', code: 1 });
    act(() => {
      ws?.simulateMessage(JSON.stringify({ type: 'history', data, offset: data.length, startOffset: 0, epoch: 1 }));
    });
    await flush();

    // The text renders twice: once as the historical row, once as the
    // current-state sibling element's own label.
    expect(screen.getAllByText(/Agent process exited \(code: 1\)/)).toHaveLength(2);

    // Exactly one Restart action exists, and it is not inside the
    // transcript's scrollable list.
    const restartButtons = screen.getAllByRole('button', { name: /Restart/ });
    expect(restartButtons).toHaveLength(1);
    const transcriptList = container.querySelector('.overflow-y-auto');
    expect(transcriptList).not.toBeNull();
    expect(transcriptList!.contains(restartButtons[0])).toBe(false);

    const user = userEvent.setup();
    await user.click(restartButtons[0]);

    // Restart forces a fresh WS connection.
    const secondWs = MockWebSocket.getLastInstance();
    expect(secondWs).not.toBe(ws);
  });

  it('#1455 POLARITY: multiple non-evicted exited rows + worker currently running (currentExit cleared) render ZERO Restart affordances anywhere', async () => {
    // This is the bug reproduction from Issue #1455: two historical `exited`
    // rows (from an earlier crash+restart, both persisted and replayed) are
    // followed in the same replay by a fresh 'ready' -- i.e. the worker is
    // ACTUALLY running right now. Before this fix, every non-evicted
    // `exited` row rendered its OWN unconditional Restart button with no
    // regard for current state, so this scenario rendered TWO live-looking
    // buttons while the worker was idle/connected the whole time -- exactly
    // the screenshot from the Issue.
    //
    // Verified polarity (workflow.md "Every pin's reach is measured, not
    // predicted"): commenting out the `currentExit !== null && ...` sibling
    // block (R2) and reverting `case 'exited':` to render its own
    // unconditional button (R1) reproduces 2 Restart buttons here against
    // this exact fixture -- confirmed by stashing the production diff and
    // re-running this test, which failed with
    // `Expected length: 0, Received length: 2` before the fix and passes
    // with it.
    renderView({ sessionId: 's7-multi', workerId: 'w7-multi' });
    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
    });

    const data = ndjson(
      { v: 1, type: 'exited', code: 1 },
      { v: 1, type: 'exited', code: 2 },
      { v: 1, type: 'ready' },
    );
    act(() => {
      ws?.simulateMessage(JSON.stringify({ type: 'history', data, offset: data.length, startOffset: 0, epoch: 1 }));
    });
    await flush();

    // Both historical exit rows are still present as plain facts...
    expect(screen.getByText(/Agent process exited \(code: 1\)/)).toBeTruthy();
    expect(screen.getByText(/Agent process exited \(code: 2\)/)).toBeTruthy();
    // ...but with the worker currently running, there is no affordance at all.
    expect(screen.queryAllByRole('button', { name: /Restart/ })).toHaveLength(0);
  });

  describe('exited row -- idle eviction (reason === evicted)', () => {
    /** Renders a view whose replayed history is a single `exited` row, optionally carrying `reason`. */
    async function renderExitedRow(idSuffix: string, reason?: string) {
      const rendered = renderView({ sessionId: `s7-${idSuffix}`, workerId: `w7-${idSuffix}` });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });

      const data = ndjson({ v: 1, type: 'exited', code: 0, ...(reason !== undefined ? { reason } : {}) });
      act(() => {
        ws?.simulateMessage(JSON.stringify({ type: 'history', data, offset: data.length, startOffset: 0, epoch: 1 }));
      });
      await flush();
      return rendered;
    }

    it('renders a quiet paused line and NO Restart button for reason: evicted (current state also evicted -- regression pin)', async () => {
      await renderExitedRow('evicted', 'evicted');

      expect(screen.getByText(/paused to free memory/)).toBeTruthy();
      // Asserted by role, not just by the new text: the point of the branch
      // is the absence of an action the user does not need to take. This
      // covers both the row (which never had one) and the current-state
      // sibling element (which is gated on `reason !== 'evicted'`).
      expect(screen.queryByRole('button', { name: /Restart/ })).toBeNull();
      expect(screen.queryByText(/Agent process exited/)).toBeNull();
    });

    it("renders today's output (row as a fact + exactly one Restart action, outside the row) when `reason` is ABSENT", async () => {
      // Regression guard for rows persisted by a server older than idle
      // eviction. A `!reason` check would fold these in with a live eviction
      // and silently take the Restart affordance away entirely.
      const { container } = await renderExitedRow('noreason');

      // Renders twice: the historical row, and the current-state sibling
      // element's own label.
      expect(screen.getAllByText(/Agent process exited/)).toHaveLength(2);
      const restartButtons = screen.getAllByRole('button', { name: /Restart/ });
      expect(restartButtons).toHaveLength(1);
      const transcriptList = container.querySelector('.overflow-y-auto');
      expect(transcriptList!.contains(restartButtons[0])).toBe(false);
      expect(screen.queryByText(/paused to free memory/)).toBeNull();
    });

    // These two are the tests that fail if someone writes a truthiness check
    // (`entry.reason ? ... : ...`) instead of `entry.reason === 'evicted'`:
    // both values are present and truthy, and both must render exactly as an
    // unreasoned exit does.
    for (const reason of ['managed', 'unexpected'] as const) {
      it(`renders today's output (row as a fact + Restart outside it) for reason: ${reason}`, async () => {
        const { container } = await renderExitedRow(reason, reason);

        // Renders twice: the historical row, and the current-state sibling
        // element's own label.
        expect(screen.getAllByText(/Agent process exited/)).toHaveLength(2);
        const restartButtons = screen.getAllByRole('button', { name: /Restart/ });
        expect(restartButtons).toHaveLength(1);
        const transcriptList = container.querySelector('.overflow-y-auto');
        expect(transcriptList!.contains(restartButtons[0])).toBe(false);
        expect(screen.queryByText(/paused to free memory/)).toBeNull();
      });
    }
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
        // Pin the exact error shape thrown by the shared copyToClipboard
        // helper (lib/clipboard.ts) now that the extraction moved this
        // construction out of this component -- guards against the
        // extraction silently changing what handleCopy logs (#1345).
        // logger.error('Failed to copy markdown:', err) forwards args
        // straight through to console.error, so the error is the second
        // positional arg. Locate the call by its message rather than
        // assuming index 0 -- React/testing-library may emit unrelated
        // console.error calls (e.g. dev warnings) earlier in the spy.
        const copyErrorCall = (consoleErrorSpy.mock.calls as unknown[][]).find(
          (call) => call[0] === 'Failed to copy markdown:'
        );
        expect(copyErrorCall).toBeDefined();
        const loggedError = copyErrorCall?.[1];
        expect(loggedError).toBeInstanceOf(Error);
        expect((loggedError as Error).message).toBe('execCommand("copy") returned false');
        expect(screen.getByRole('button', { name: 'Copy as markdown' })).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Copied!' })).toBeNull();
      } finally {
        Reflect.deleteProperty(document, 'execCommand');
        consoleErrorSpy.mockRestore();
      }
    });
  });

  describe('Compaction', () => {
    it('renders an indeterminate progressbar with no aria-value* attributes when the worker has no contextWindowTokens configured', () => {
      renderView({ sessionId: 's-ctx-1', workerId: 'w-ctx-1' });

      const bar = screen.getByRole('progressbar');
      expect(bar.getAttribute('aria-valuenow')).toBeNull();
      expect(bar.getAttribute('aria-valuemin')).toBeNull();
      expect(bar.getAttribute('aria-valuemax')).toBeNull();
    });

    it('renders a determinate progressbar with aria-valuenow and colour bands driven by context-usage events', async () => {
      // Fixture threshold is 0.8, so the amber band opens at 0.65.
      globalThis.fetch = Object.assign(mock(makeEmbeddedViewFetch([embeddedAgentFixture()])), { preconnect: () => {} });
      renderView({ sessionId: 's-ctx-2', workerId: 'w-ctx-2', embeddedAgentId: 'ea-1' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });
      await flush();

      act(() => {
        const data = ndjson({ v: 1, type: 'context-usage', promptTokens: 300, estimated: false });
        ws?.simulateMessage(JSON.stringify({ type: 'history', data, offset: data.length, startOffset: 0, epoch: 1 }));
      });
      await flush();
      let bar = screen.getByRole('progressbar');
      expect(bar.getAttribute('aria-valuenow')).toBe('30');
      expect(bar.querySelector('div')?.className).toContain('bg-gray-500');

      act(() => {
        const data = ndjson({ v: 1, type: 'context-usage', promptTokens: 700, estimated: false });
        ws?.simulateMessage(JSON.stringify({ type: 'output', data, offset: data.length }));
      });
      await flush();
      bar = screen.getByRole('progressbar');
      expect(bar.getAttribute('aria-valuenow')).toBe('70');
      expect(bar.querySelector('div')?.className).toContain('bg-amber-500');

      act(() => {
        const data = ndjson({ v: 1, type: 'context-usage', promptTokens: 900, estimated: false });
        ws?.simulateMessage(JSON.stringify({ type: 'output', data, offset: data.length }));
      });
      await flush();
      bar = screen.getByRole('progressbar');
      expect(bar.getAttribute('aria-valuenow')).toBe('90');
      expect(bar.querySelector('div')?.className).toContain('bg-red-600');
    });

    it('never shows a threshold banner or a manual-compaction CTA, however high usage climbs', async () => {
      // The banners and their "Handoff now" CTA are deleted: automatic
      // compaction is the toggle, and manual compaction is a request made to
      // the agent in the message box. A banner here would point at a button
      // that no longer exists.
      globalThis.fetch = Object.assign(mock(makeEmbeddedViewFetch([embeddedAgentFixture()])), { preconnect: () => {} });
      renderView({ sessionId: 's-ctx-3', workerId: 'w-ctx-3', embeddedAgentId: 'ea-1' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });
      await flush();

      act(() => {
        const data = ndjson({ v: 1, type: 'context-usage', promptTokens: 990, estimated: false });
        ws?.simulateMessage(JSON.stringify({ type: 'history', data, offset: data.length, startOffset: 0, epoch: 1 }));
      });
      await flush();

      expect(screen.queryByText(/Context is/)).toBeNull();
      expect(screen.queryByRole('button', { name: /Handoff/i })).toBeNull();
    });

    it('renders the boundary marker with an expandable summary on a context-compacted event', async () => {
      renderView({ sessionId: 's-ctx-4', workerId: 'w-ctx-4' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });
      await flush();

      act(() => {
        const data = ndjson({
          v: 1,
          type: 'context-compacted',
          source: 'auto',
          summary: 'THE SUMMARY',
          preTokens: 102150,
          postTokens: 2710,
        });
        ws?.simulateMessage(JSON.stringify({ type: 'history', data, offset: data.length, startOffset: 0, epoch: 1 }));
      });
      await flush();

      // A statement of fact, carrying the compaction's own severity -- see
      // formatCompactionBoundaryLabel's doc comment for why it must never be
      // a preservation promise.
      expect(screen.getByText('— Context compacted (102k → 2.7k) —')).toBeTruthy();
      expect(screen.getByText('THE SUMMARY')).toBeTruthy();
    });

    it('renders the provider-stated limit on the boundary line when the rejection named one', async () => {
      // The shipping path for signal 3, end to end: NDJSON row -> store
      // mapper -> boundary render. The field travels the same wire the
      // marker does, which is why this case drives the socket rather than
      // constructing an entry.
      renderView({ sessionId: 's-ctx-drift', workerId: 'w-ctx-drift' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });
      await flush();

      act(() => {
        const data = ndjson({
          v: 1,
          type: 'context-compacted',
          source: 'auto',
          preTokens: 102150,
          postTokens: 2710,
          providerStatedWindowTokens: 983616,
        });
        ws?.simulateMessage(JSON.stringify({ type: 'history', data, offset: data.length, startOffset: 0, epoch: 1 }));
      });
      await flush();

      // Grouped, not localeString-free: the number an operator compares
      // against their configured window has to be readable at a glance.
      expect(screen.getByText(/The provider states its input limit is 983,616 tokens/)).toBeTruthy();
      // The boundary itself is unchanged by the addition.
      expect(screen.getByText('— Context compacted (102k → 2.7k) —')).toBeTruthy();
    });

    it('renders no provider-limit line when the compaction carries no stated limit', async () => {
      // The negative half. Without it, an unconditional line satisfies the
      // positive case, and every ordinary compaction would carry a warning
      // about a limit nobody reported.
      renderView({ sessionId: 's-ctx-nodrift', workerId: 'w-ctx-nodrift' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });
      await flush();

      act(() => {
        const data = ndjson({ v: 1, type: 'context-compacted', source: 'auto', preTokens: 102150, postTokens: 2710 });
        ws?.simulateMessage(JSON.stringify({ type: 'history', data, offset: data.length, startOffset: 0, epoch: 1 }));
      });
      await flush();

      expect(screen.getByText('— Context compacted (102k → 2.7k) —')).toBeTruthy();
      expect(screen.queryByText(/The provider states its input limit/)).toBeNull();
    });

    it('renders the boundary marker as a plain line when the event carries no summary', async () => {
      renderView({ sessionId: 's-ctx-5', workerId: 'w-ctx-5' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });
      await flush();

      act(() => {
        const data = ndjson({ v: 1, type: 'context-compacted', source: 'manual' });
        ws?.simulateMessage(JSON.stringify({ type: 'history', data, offset: data.length, startOffset: 0, epoch: 1 }));
      });
      await flush();

      expect(screen.getByText('— Context compacted —')).toBeTruthy();
      // No disclosure to open: an empty <details> would invite a click onto
      // nothing.
      expect(document.querySelector('details')).toBeNull();
    });

    it('R2 (#1447 stage 4): renders a plain boundary line on a restore-failure-boundary event, same visual family as context-compacted', async () => {
      renderView({ sessionId: 's-ctx-7', workerId: 'w-ctx-7' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });
      await flush();

      act(() => {
        const data = ndjson({ v: 1, type: 'restore-failure-boundary' });
        ws?.simulateMessage(JSON.stringify({ type: 'history', data, offset: data.length, startOffset: 0, epoch: 1 }));
      });
      await flush();

      expect(
        screen.getByText('— Earlier conversation could not be restored; this turn continues from here —'),
      ).toBeTruthy();
      // No summary to disclose -- this marker never carries one (R2 addendum).
      expect(document.querySelector('details')).toBeNull();
    });

    it('R6 (#1447 stage 4): renders a quiet notification row on a restore-failure-declaration event', async () => {
      renderView({ sessionId: 's-ctx-8', workerId: 'w-ctx-8' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });
      await flush();

      act(() => {
        const data = ndjson({ v: 1, type: 'restore-failure-declaration' });
        ws?.simulateMessage(JSON.stringify({ type: 'history', data, offset: data.length, startOffset: 0, epoch: 1 }));
      });
      await flush();

      expect(
        screen.getByText("— This worker's earlier conversation is not shown here, but the agent may still remember it —"),
      ).toBeTruthy();
    });

    it('REGRESSION (#1401): still renders a LEGACY context-handoff row from a historical stream', async () => {
      // Persisted transcripts written before the compaction swap contain
      // `context-handoff` rows and replay them on every history load. The
      // fixture is a whole historical stream, so this also pins that the
      // surrounding rows still render in order around the legacy boundary.
      renderView({ sessionId: 's-ctx-6', workerId: 'w-ctx-6' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });
      await flush();

      act(() => {
        const data = ndjson(
          { v: 1, type: 'user-message', id: 'm1', text: 'before the handoff' },
          { v: 1, type: 'context-handoff', distillation: 'THE OLD DISTILLATION' },
          { v: 1, type: 'user-message', id: 'm2', text: 'after the handoff' },
        );
        ws?.simulateMessage(JSON.stringify({ type: 'history', data, offset: data.length, startOffset: 0, epoch: 1 }));
      });
      await flush();

      expect(screen.getByText('— Context handoff: conversation restarted from summary —')).toBeTruthy();
      expect(screen.getByText('THE OLD DISTILLATION')).toBeTruthy();
      expect(screen.getByText('before the handoff')).toBeTruthy();
      expect(screen.getByText('after the handoff')).toBeTruthy();
    });

    describe('the auto-compaction toggle', () => {
      it('reflects the worker\'s server value', () => {
        renderView({ sessionId: 's-tog-1', workerId: 'w-tog-1', autoCompaction: false });

        const toggle = screen.getByRole('checkbox', {
          name: /Compact automatically when the context fills up/,
        });
        expect((toggle as HTMLInputElement).checked).toBe(false);
      });

      it('is ON when the worker says so', () => {
        renderView({ sessionId: 's-tog-2', workerId: 'w-tog-2', autoCompaction: true });

        const toggle = screen.getByRole('checkbox', {
          name: /Compact automatically when the context fills up/,
        });
        expect((toggle as HTMLInputElement).checked).toBe(true);
      });

      it('does NOT substitute the ON default when the server value is unknown, and is not clickable then', async () => {
        // The ON default belongs to the server (`workers.auto_compaction NOT
        // NULL DEFAULT 1`). Repeating it here would give one fact two
        // sources, so a field dropped at the wire would render as a confident
        // ON and look perfectly normal -- the Gap-Scan Q10 failure shape,
        // which this PR already hit once at a different gate. Unknown must
        // therefore read as "not available", and must not be writable: a
        // click from a guessed baseline would PATCH a value the user never
        // saw the truth of.
        // Parameters declared so `mock.calls` carries them -- an argument-less
        // mock records a zero-length tuple, and the PATCH assertion below has
        // to read the request init.
        const fetchMock = mock(
          async (_input: RequestInfo | URL, _init?: RequestInit) =>
            new Response(JSON.stringify([]), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
        );
        globalThis.fetch = Object.assign(fetchMock, { preconnect: () => {} });
        renderView({ sessionId: 's-tog-unknown', workerId: 'w-tog-unknown' });

        const toggle = screen.getByRole('checkbox', {
          name: /Compact automatically when the context fills up/,
        }) as HTMLInputElement;
        expect(toggle.checked).toBe(false);
        expect(toggle.disabled).toBe(true);

        await userEvent.setup().click(toggle).catch(() => {});
        expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
      });

      it('never names an engine or a mechanism in its wording', () => {
        // §3.1's no-leak principle: from the user's side this is one
        // feature, however differently the two engines implement it.
        renderView({ sessionId: 's-tog-3', workerId: 'w-tog-3', autoCompaction: true });

        const label = screen.getByText(/Compact automatically when the context fills up/);
        expect(label.textContent).not.toMatch(/engine|SDK|openai/i);
      });

      it('PATCHes the worker when clicked', async () => {
        const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = typeof input === 'string' ? input : input.toString();
          if (url.includes('/api/sessions/') && init?.method === 'PATCH') {
            return new Response(JSON.stringify({ worker: {} }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          return new Response(JSON.stringify([]), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        });
        globalThis.fetch = Object.assign(fetchMock, { preconnect: () => {} });
        const user = userEvent.setup();
        renderView({ sessionId: 's-tog-4', workerId: 'w-tog-4', autoCompaction: true });

        await user.click(
          screen.getByRole('checkbox', { name: /Compact automatically when the context fills up/ }),
        );

        await waitFor(() => {
          const patchCall = fetchMock.mock.calls.find(
            ([, init]) => (init as RequestInit | undefined)?.method === 'PATCH',
          );
          expect(patchCall).toBeDefined();
          expect(String(patchCall![0])).toContain('/api/sessions/s-tog-4/workers/w-tog-4');
          expect(JSON.parse(String((patchCall![1] as RequestInit).body))).toEqual({
            autoCompaction: false,
          });
        });
      });
    });
  });

  describe('Transcript Restore (#1123)', () => {
    it('renders a restore-repair note (closed by default) when restore-info carries repairedToolCallIds', async () => {
      renderView({ sessionId: 's-restore-1', workerId: 'w-restore-1' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });
      await flush();

      act(() => {
        ws?.simulateMessage(
          JSON.stringify({
            type: 'restore-info',
            epoch: 1,
            restoredMessageCount: 5,
            repairedToolCallIds: ['call-1', 'call-2'],
            completed: false,
          }),
        );
      });
      await flush();

      const summary = screen.getByText(
        '— Some tool calls were interrupted by a restart and marked as errors —',
      );
      const details = summary.closest('details') as HTMLDetailsElement;
      expect(details).toBeTruthy();
      expect(details.open).toBe(false);
      expect(screen.getByText('2 tool calls affected.')).toBeTruthy();
    });

    it('shows the "Loading N previous messages..." indicator while restoring is true, and hides it once a completed:true restore-info push arrives (#1205)', async () => {
      renderView({ sessionId: 's-restore-2', workerId: 'w-restore-2' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });
      await flush();

      expect(screen.queryByText(/Loading \d+ previous message/)).toBeNull();

      act(() => {
        ws?.simulateMessage(
          JSON.stringify({
            type: 'restore-info',
            epoch: 1,
            restoredMessageCount: 5,
            repairedToolCallIds: [],
            completed: false,
          }),
        );
      });
      await flush();

      expect(screen.getByText('Loading 5 previous messages...')).toBeTruthy();

      // Server-authoritative (#1205): the indicator clears on a FRESH restore-info
      // push carrying completed: true (sent the moment the new incarnation's
      // `ready` event is observed server-side), not merely from a `ready`
      // event folding client-side -- a successful restore does not mint a
      // new epoch, and a `ready` fold can race `restore-info` in either
      // order, so it must not drive `restoring` on its own.
      act(() => {
        ws?.simulateMessage(
          JSON.stringify({
            type: 'restore-info',
            epoch: 1,
            restoredMessageCount: 5,
            repairedToolCallIds: [],
            completed: true,
          }),
        );
      });
      await flush();

      expect(screen.queryByText(/Loading \d+ previous message/)).toBeNull();
    });

    it('never claims "Restoring conversation" for a claude-sdk engine worker while restoring is true -- the loading indicator wording must not imply session continuity (Browser QA follow-up)', async () => {
      globalThis.fetch = Object.assign(
        mock(
          makeEmbeddedViewFetch([
            embeddedAgentFixture({ engine: 'claude-sdk', provider: { model: 'claude-opus-4' } }),
          ]),
        ),
        { preconnect: () => {} },
      );
      renderView({ sessionId: 's-restore-3', workerId: 'w-restore-3', embeddedAgentId: 'ea-1' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });
      await flush();

      act(() => {
        ws?.simulateMessage(
          JSON.stringify({
            type: 'restore-info',
            epoch: 1,
            restoredMessageCount: 3,
            repairedToolCallIds: [],
            completed: false,
          }),
        );
      });
      await flush();

      expect(screen.queryByText(/Restoring conversation/)).toBeNull();
      expect(screen.getByText('Loading 3 previous messages...')).toBeTruthy();
    });

    it('still shows the neutral "Loading N previous messages..." progress wording for an openai-api engine worker while restoring is true', async () => {
      globalThis.fetch = Object.assign(
        mock(makeEmbeddedViewFetch([embeddedAgentFixture()])),
        { preconnect: () => {} },
      );
      renderView({ sessionId: 's-restore-4', workerId: 'w-restore-4', embeddedAgentId: 'ea-1' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });
      await flush();

      act(() => {
        ws?.simulateMessage(
          JSON.stringify({
            type: 'restore-info',
            epoch: 1,
            restoredMessageCount: 1,
            repairedToolCallIds: [],
            completed: false,
          }),
        );
      });
      await flush();

      expect(screen.getByText(/Loading \d+ previous messages?\.\.\./i)).toBeTruthy();
    });

    // The two tests below assert the EXACT rendered string, not a `\d+`
    // regex, because the number in it is the whole point after #1428:
    // `restoredMessageCount` now counts entries recovered from the persisted
    // transcript, so the indicator must report the number the server sent
    // rather than a reconstruction array's length.
    //
    // Mutation reach (measured, see the PR report): breaks under "store drops
    // the field" (read `message.restoredMessageCount` as the pre-rename
    // `message.messageCount`, which yields `undefined`) -- the indicator then
    // renders "Loading undefined previous messages...". NOT broken by
    // relaxing the divergence gate's `> 0` to `>= 0`, which this block does
    // not consult.
    it('renders the received count verbatim in the loading indicator for an ordinary restore (plural form)', async () => {
      renderView({ sessionId: 's-restore-5', workerId: 'w-restore-5' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });
      await flush();

      act(() => {
        ws?.simulateMessage(
          JSON.stringify({
            type: 'restore-info',
            epoch: 1,
            restoredMessageCount: 4,
            repairedToolCallIds: [],
            completed: false,
          }),
        );
      });
      await flush();

      expect(screen.getByText('Loading 4 previous messages...')).toBeTruthy();
    });

    it('renders the SINGULAR form for a past-a-boundary restore that recovered exactly one entry', async () => {
      // Reachable in production, not a contrived boundary: a worker whose
      // transcript was compacted and which said nothing afterwards restores
      // the compaction summary and nothing else, so the server sends exactly
      // 1. Under the pre-#1428 meaning the count was the reconstruction
      // array's length and this state reported 2, so the singular branch
      // rendered only for a one-message-since-activation worker.
      renderView({ sessionId: 's-restore-6', workerId: 'w-restore-6' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });
      await flush();

      act(() => {
        ws?.simulateMessage(
          JSON.stringify({
            type: 'restore-info',
            epoch: 1,
            restoredMessageCount: 1,
            repairedToolCallIds: [],
            completed: false,
          }),
        );
      });
      await flush();

      expect(screen.getByText('Loading 1 previous message...')).toBeTruthy();
      expect(screen.queryByText('Loading 1 previous messages...')).toBeNull();
    });
  });

  describe('SDK-engine restore-divergence notice (#1335; polarity inverted by R1 #1410)', () => {
    it('shows the divergence notice (not the generic restore banner) when a claude-sdk resume did NOT take', async () => {
      globalThis.fetch = Object.assign(
        mock(
          makeEmbeddedViewFetch([
            embeddedAgentFixture({ engine: 'claude-sdk', provider: { model: 'claude-opus-4' } }),
          ]),
        ),
        { preconnect: () => {} },
      );
      renderView({ sessionId: 's-sdk-restore-1', workerId: 'w-sdk-restore-1', embeddedAgentId: 'ea-1' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });
      await flush();

      act(() => {
        ws?.simulateMessage(
          JSON.stringify({
            type: 'restore-info',
            epoch: 1,
            restoredMessageCount: 5,
            repairedToolCallIds: [],
            completed: true,
            // R1: `false`, explicitly. Before R1 this test passed with the
            // field absent -- the notice was unconditional. It is the
            // presence of `false` that now earns the notice.
            sdkResumed: false,
          }),
        );
      });
      await flush();

      expect(
        screen.getByText(/earlier conversation could not be carried over/i),
      ).toBeTruthy();
      expect(
        screen.queryByText(/Conversation is restored automatically after a worker or server restart/i),
      ).toBeNull();
    });

    it('shows NO notice when a claude-sdk resume DID take -- the inverted case', async () => {
      // The polarity inversion itself. Before R1 this exact scenario showed
      // the divergence notice; it must now show nothing, because the
      // conversation genuinely did continue. A reader who ports the old
      // unconditional rule forward breaks this test and nothing else.
      globalThis.fetch = Object.assign(
        mock(
          makeEmbeddedViewFetch([
            embeddedAgentFixture({ engine: 'claude-sdk', provider: { model: 'claude-opus-4' } }),
          ]),
        ),
        { preconnect: () => {} },
      );
      renderView({ sessionId: 's-sdk-resumed', workerId: 'w-sdk-resumed', embeddedAgentId: 'ea-1' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });
      await flush();

      act(() => {
        ws?.simulateMessage(
          JSON.stringify({
            type: 'restore-info',
            epoch: 1,
            restoredMessageCount: 5,
            repairedToolCallIds: [],
            completed: true,
            sdkResumed: true,
          }),
        );
      });
      await flush();

      expect(screen.queryByText(/earlier conversation could not be carried over/i)).toBeNull();
      // And still not the openai-api banner, whose claim is about a
      // reconstruction this engine does not do.
      expect(
        screen.queryByText(/Conversation is restored automatically after a worker or server restart/i),
      ).toBeNull();
    });

    it('shows NO notice for a claude-sdk worker whose restore-info omits sdkResumed', async () => {
      // Absence is not failure. A `claude-sdk` worker can legitimately have
      // no answer yet, and reading absence as `false` -- the `!sdkResumed`
      // trap -- would show the notice here and on every openai-api worker.
      globalThis.fetch = Object.assign(
        mock(
          makeEmbeddedViewFetch([
            embeddedAgentFixture({ engine: 'claude-sdk', provider: { model: 'claude-opus-4' } }),
          ]),
        ),
        { preconnect: () => {} },
      );
      renderView({ sessionId: 's-sdk-absent', workerId: 'w-sdk-absent', embeddedAgentId: 'ea-1' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });
      await flush();

      act(() => {
        ws?.simulateMessage(
          JSON.stringify({
            type: 'restore-info',
            epoch: 1,
            restoredMessageCount: 5,
            repairedToolCallIds: [],
            completed: true,
          }),
        );
      });
      await flush();

      expect(screen.queryByText(/earlier conversation could not be carried over/i)).toBeNull();
    });

    it('shows the notice once the server corrects an optimistic true down to false', async () => {
      // The residual path end to end on the client: activation reported an
      // intended resume, the subprocess then said it did not take, and the
      // server re-pushed. The notice must appear on the correction.
      globalThis.fetch = Object.assign(
        mock(
          makeEmbeddedViewFetch([
            embeddedAgentFixture({ engine: 'claude-sdk', provider: { model: 'claude-opus-4' } }),
          ]),
        ),
        { preconnect: () => {} },
      );
      renderView({ sessionId: 's-sdk-corrected', workerId: 'w-sdk-corrected', embeddedAgentId: 'ea-1' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });
      await flush();

      const restoreInfo = (sdkResumed: boolean) =>
        JSON.stringify({
          type: 'restore-info',
          epoch: 1,
          restoredMessageCount: 5,
          repairedToolCallIds: [],
          completed: true,
          sdkResumed,
        });

      act(() => {
        ws?.simulateMessage(restoreInfo(true));
      });
      await flush();
      expect(screen.queryByText(/earlier conversation could not be carried over/i)).toBeNull();

      act(() => {
        ws?.simulateMessage(restoreInfo(false));
      });
      await flush();
      expect(screen.getByText(/earlier conversation could not be carried over/i)).toBeTruthy();
    });

    it('does not show the divergence notice for an openai-api engine worker, and still shows the generic restore banner', async () => {
      globalThis.fetch = Object.assign(
        mock(makeEmbeddedViewFetch([embeddedAgentFixture()])),
        { preconnect: () => {} },
      );
      renderView({ sessionId: 's-sdk-restore-2', workerId: 'w-sdk-restore-2', embeddedAgentId: 'ea-1' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });
      await flush();

      act(() => {
        ws?.simulateMessage(
          JSON.stringify({
            type: 'restore-info',
            epoch: 1,
            restoredMessageCount: 5,
            repairedToolCallIds: [],
            completed: true,
          }),
        );
      });
      await flush();

      expect(
        screen.queryByText(/earlier conversation could not be carried over/i),
      ).toBeNull();
      expect(
        screen.getByText(/Conversation is restored automatically after a worker or server restart/i),
      ).toBeTruthy();
    });

    // #1428 PAIR: the reachability case and its presence control, kept
    // adjacent on purpose. "No notice appeared" on its own cannot tell
    // "nothing was restored" apart from "the notice logic is broken", so the
    // second test below drives the notice with the SAME engine, the SAME
    // `sdkResumed: false`, and only the count changed.
    it('shows NO divergence notice for a claude-sdk worker whose restore recovered nothing, even though the resume did not take (#1428)', async () => {
      // THE POINT OF #1428. `restoredMessageCount` used to be the
      // reconstruction's whole array length including its seed, so it had a
      // floor of 1 and this state was UNREACHABLE: an activated-but-never-
      // spoken-to worker reported >= 1 and the notice fired, telling the user
      // an "earlier conversation" they never had could not be carried over.
      // The count now excludes the synthetic system prompt, so 0 is a real
      // wire value and the gate's first conjunct can finally go false.
      //
      // Mutation reach (measured): relaxing the gate's `restoredMessageCount
      // > 0` to `>= 0` in EmbeddedAgentWorkerView.tsx makes this test fail
      // (the notice reappears) and leaves the control below passing.
      // NOT broken by "store drops the field" (undefined > 0 is also false).
      globalThis.fetch = Object.assign(
        mock(
          makeEmbeddedViewFetch([
            embeddedAgentFixture({ engine: 'claude-sdk', provider: { model: 'claude-opus-4' } }),
          ]),
        ),
        { preconnect: () => {} },
      );
      renderView({ sessionId: 's-sdk-empty', workerId: 'w-sdk-empty', embeddedAgentId: 'ea-1' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });
      await flush();

      act(() => {
        ws?.simulateMessage(
          JSON.stringify({
            type: 'restore-info',
            epoch: 1,
            restoredMessageCount: 0,
            repairedToolCallIds: [],
            completed: true,
            sdkResumed: false,
          }),
        );
      });
      await flush();

      expect(screen.queryByText(/earlier conversation could not be carried over/i)).toBeNull();
      expect(
        screen.queryByText(/Conversation is restored automatically after a worker or server restart/i),
      ).toBeNull();
    });

    it('PRESENCE CONTROL for the test above: the same claude-sdk worker with a non-empty restore DOES show the notice (#1428)', async () => {
      // Identical setup to the test above -- same engine, same
      // `sdkResumed: false`, same `completed: true` -- with only
      // `restoredMessageCount` changed from 0 to 2. If this one also showed
      // nothing, the absence assertion above would be satisfied by a broken
      // notice rather than by the count reaching 0, and would keep passing
      // through any future regression of the divergence notice.
      //
      // Mutation reach (measured): breaks under "store drops the field"
      // (reading the pre-rename `message.messageCount` yields `undefined`,
      // so `undefined > 0` suppresses the notice). NOT broken by relaxing
      // the gate's `> 0` to `>= 0`, which only widens what shows the notice.
      globalThis.fetch = Object.assign(
        mock(
          makeEmbeddedViewFetch([
            embeddedAgentFixture({ engine: 'claude-sdk', provider: { model: 'claude-opus-4' } }),
          ]),
        ),
        { preconnect: () => {} },
      );
      renderView({ sessionId: 's-sdk-nonempty', workerId: 'w-sdk-nonempty', embeddedAgentId: 'ea-1' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });
      await flush();

      act(() => {
        ws?.simulateMessage(
          JSON.stringify({
            type: 'restore-info',
            epoch: 1,
            restoredMessageCount: 2,
            repairedToolCallIds: [],
            completed: true,
            sdkResumed: false,
          }),
        );
      });
      await flush();

      expect(screen.getByText(/earlier conversation could not be carried over/i)).toBeTruthy();
    });

    it('shows neither banner for a claude-sdk engine worker with no prior transcript (fresh worker, no restore-info push)', async () => {
      globalThis.fetch = Object.assign(
        mock(
          makeEmbeddedViewFetch([
            embeddedAgentFixture({ engine: 'claude-sdk', provider: { model: 'claude-opus-4' } }),
          ]),
        ),
        { preconnect: () => {} },
      );
      renderView({ sessionId: 's-sdk-restore-3', workerId: 'w-sdk-restore-3', embeddedAgentId: 'ea-1' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });
      await flush();

      expect(
        screen.queryByText(/earlier conversation could not be carried over/i),
      ).toBeNull();
      expect(
        screen.queryByText(/Conversation is restored automatically after a worker or server restart/i),
      ).toBeNull();
    });

    it('renders neither banner while the embedded-agents registry is still loading (unresolved engine, not yet known to be openai-api)', async () => {
      let resolveEmbeddedAgents: (response: Response) => void = () => {};
      const embeddedAgentsPromise = new Promise<Response>((resolve) => {
        resolveEmbeddedAgents = resolve;
      });
      globalThis.fetch = Object.assign(
        mock((input: RequestInfo | URL): Promise<Response> => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          if (url.endsWith('/api/skills')) return Promise.resolve(jsonResponse({ skills: [] }));
          if (url.endsWith('/api/message-templates')) return Promise.resolve(jsonResponse({ templates: [] }));
          if (url.endsWith('/api/embedded-agents')) return embeddedAgentsPromise;
          return Promise.resolve(new Response('null', { status: 404 }));
        }),
        { preconnect: () => {} },
      );

      renderView({ sessionId: 's-sdk-restore-4', workerId: 'w-sdk-restore-4', embeddedAgentId: 'ea-1' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });
      await flush();

      // Push a restore-info with a non-empty restoredMessageCount WHILE the
      // `/api/embedded-agents` fetch is still pending, so
      // hadPriorTranscriptThisIncarnation is true but the engine is still
      // unresolved -- this is what makes the assertions below non-vacuous:
      // without this push, restoredMessageCount stays null and the
      // divergence-notice assertion would pass regardless of whether the
      // engine-unresolved guard does anything at all.
      act(() => {
        ws?.simulateMessage(
          JSON.stringify({
            type: 'restore-info',
            epoch: 1,
            restoredMessageCount: 3,
            repairedToolCallIds: [],
            completed: true,
          }),
        );
      });
      await flush();

      // The `/api/embedded-agents` fetch is still pending -- embeddedAgentDefinition
      // is undefined, so the engine is genuinely unknown (not yet confirmed
      // openai-api). Neither banner may render a claim about an engine we
      // haven't resolved.
      expect(
        screen.queryByText(/Conversation is restored automatically after a worker or server restart/i),
      ).toBeNull();
      expect(
        screen.queryByText(/earlier conversation could not be carried over/i),
      ).toBeNull();

      // Resolve the pending fetch so it doesn't leak into a later test.
      await act(async () => {
        resolveEmbeddedAgents(jsonResponse({ embeddedAgents: [] }));
        await flush();
      });
    });
  });

  describe('#1449 restore-failure notice', () => {
    // Regexes distinguishing the two sentences by their distinctive tail.
    const D2_RE = /could not be restored for display, but the agent may still remember it/i;
    const LOSS_RE = /could not be restored — a diagnostic copy of the record has been preserved/i;
    const D1_RE = /earlier conversation could not be carried over/i;
    const GENERIC_OPENAI_RE = /Conversation is restored automatically after a worker or server restart/i;

    it('claude-sdk + failed:true + sdkResumed:true -> D2 shown, Loss/D1/generic banner NOT shown', async () => {
      globalThis.fetch = Object.assign(
        mock(
          makeEmbeddedViewFetch([
            embeddedAgentFixture({ engine: 'claude-sdk', provider: { model: 'claude-opus-4' } }),
          ]),
        ),
        { preconnect: () => {} },
      );
      renderView({ sessionId: 's-1449-d2', workerId: 'w-1449-d2', embeddedAgentId: 'ea-1' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });
      await flush();

      act(() => {
        ws?.simulateMessage(JSON.stringify({ type: 'restore-info', epoch: 1, failed: true, sdkResumed: true }));
      });
      await flush();

      expect(screen.getByText(D2_RE)).toBeTruthy();
      expect(screen.queryByText(LOSS_RE)).toBeNull();
      expect(screen.queryByText(D1_RE)).toBeNull();
      expect(screen.queryByText(GENERIC_OPENAI_RE)).toBeNull();
    });

    // Mutation reach (measured 2026-08-30): weakening `restoreDivergedD2`
    // from `restoreFailed && isSdkEngine && sdkResumed !== false` to
    // `restoreFailed` alone (D2 fires on any restoreFailed, regardless of
    // engine/sdkResumed) makes THIS test fail, along with the "mutual
    // exclusivity" and "monotonicity" tests further below in this suite --
    // 3 of 6 tests in this describe block failed under the mutation.
    // Confirmed by temporarily applying the mutation, running `bun test`,
    // and restoring it.
    it('claude-sdk + failed:true + sdkResumed:false -> Loss shown, D2 NOT shown', async () => {
      globalThis.fetch = Object.assign(
        mock(
          makeEmbeddedViewFetch([
            embeddedAgentFixture({ engine: 'claude-sdk', provider: { model: 'claude-opus-4' } }),
          ]),
        ),
        { preconnect: () => {} },
      );
      renderView({ sessionId: 's-1449-loss-sdk', workerId: 'w-1449-loss-sdk', embeddedAgentId: 'ea-1' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });
      await flush();

      act(() => {
        ws?.simulateMessage(JSON.stringify({ type: 'restore-info', epoch: 1, failed: true, sdkResumed: false }));
      });
      await flush();

      expect(screen.getByText(LOSS_RE)).toBeTruthy();
      expect(screen.queryByText(D2_RE)).toBeNull();
    });

    it('claude-sdk + failed:true + sdkResumed absent -> D2 shown (per the derivation, only === false selects Loss)', async () => {
      // Reachability check against the actual wire contract (Wave 1,
      // embedded-agent-worker-service.ts): the server's failure-form
      // construction sets `sdkResumed: resumeId !== null` unconditionally
      // for `claude-sdk` -- it is ALWAYS a literal boolean on that engine,
      // never omitted. A truly-absent `sdkResumed` on a claude-sdk failure
      // form is therefore not producible by the current server; it is
      // reachable only as "a message from an older/different server that
      // predates this field" -- the same defensive case the wire type's
      // `sdkResumed?: boolean` optionality exists for on every other
      // restore-info field. This test exercises the CLIENT's own derivation
      // contract for that message shape directly (crafted here, not routed
      // through server code), which is what the three-valued discipline
      // requires it to handle correctly regardless of whether today's server
      // happens to produce it.
      //
      // Mutation reach (measured 2026-08-30): narrowing the
      // `restoreDivergedD2` gate's `sdkResumed !== false` to
      // `sdkResumed === true` makes THIS test fail (and only this one --
      // 5 of 6 tests in this describe block still pass) -- absent no longer
      // satisfies `=== true`, so neither banner renders and the D2 assertion
      // fails. This is what demonstrates the derivation table's requirement
      // -- absent renders D2, only `=== false` selects Loss -- is
      // load-bearing and not accidental. Confirmed by temporarily narrowing
      // the comparison, running `bun test`, and restoring it.
      globalThis.fetch = Object.assign(
        mock(
          makeEmbeddedViewFetch([
            embeddedAgentFixture({ engine: 'claude-sdk', provider: { model: 'claude-opus-4' } }),
          ]),
        ),
        { preconnect: () => {} },
      );
      renderView({ sessionId: 's-1449-absent', workerId: 'w-1449-absent', embeddedAgentId: 'ea-1' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });
      await flush();

      act(() => {
        ws?.simulateMessage(JSON.stringify({ type: 'restore-info', epoch: 1, failed: true }));
      });
      await flush();

      expect(screen.getByText(D2_RE)).toBeTruthy();
      expect(screen.queryByText(LOSS_RE)).toBeNull();
    });

    it('openai-api + failed:true -> Loss shown, using the EXACT SAME string as the claude-sdk Loss case (condition 3)', async () => {
      // claude-sdk side of the pair.
      globalThis.fetch = Object.assign(
        mock(
          makeEmbeddedViewFetch([
            embeddedAgentFixture({ engine: 'claude-sdk', provider: { model: 'claude-opus-4' } }),
          ]),
        ),
        { preconnect: () => {} },
      );
      const sdkView = renderView({ sessionId: 's-1449-loss-a', workerId: 'w-1449-loss-a', embeddedAgentId: 'ea-1' });
      const sdkWs = MockWebSocket.getLastInstance();
      act(() => {
        sdkWs?.simulateOpen();
      });
      await flush();
      act(() => {
        sdkWs?.simulateMessage(JSON.stringify({ type: 'restore-info', epoch: 1, failed: true, sdkResumed: false }));
      });
      await flush();

      // openai-api side of the pair -- fetch stub swapped, no cleanup()
      // between the two renders (both stay mounted; queries below are scoped
      // per-container, mirroring the "Working accordion replay vs live"
      // suite's dual-render pattern above).
      globalThis.fetch = Object.assign(mock(makeEmbeddedViewFetch([embeddedAgentFixture()])), {
        preconnect: () => {},
      });
      const apiView = renderView({ sessionId: 's-1449-loss-b', workerId: 'w-1449-loss-b', embeddedAgentId: 'ea-1' });
      const apiWs = MockWebSocket.getLastInstance();
      act(() => {
        apiWs?.simulateOpen();
      });
      await flush();
      act(() => {
        apiWs?.simulateMessage(JSON.stringify({ type: 'restore-info', epoch: 1, failed: true }));
      });
      await flush();

      const sdkScope = within(sdkView.container);
      const apiScope = within(apiView.container);
      const sdkLossText = sdkScope.getByText(LOSS_RE).textContent;
      const apiLossText = apiScope.getByText(LOSS_RE).textContent;
      // The actual pin: identical wording regardless of which engine
      // triggered it. A future accidental engine-branch on the Loss string
      // would break this specific assertion, not just "matches /some
      // pattern/i" independently in each render.
      expect(sdkLossText).toBe(apiLossText);
    });

    describe('R4 (#1447 stage 4): banner copy conditioned on preservation', () => {
      // Each variant renders EXACTLY the string the design doc specifies for
      // its (direction, preservation) pair, and none of the other five --
      // "renders only under its true preservation state" per the AC's
      // "Banner honesty" verification item.
      const D2_IN_BAND =
        "This worker's earlier conversation is still shown above. The agent does not carry it forward from here, but it may still remember it independently.";
      const D2_SIDECAR =
        "This worker's earlier conversation could not be restored for display, but the agent may still remember it, and a diagnostic copy of the record has been preserved.";
      const D2_LOST =
        "This worker's earlier conversation could not be restored for display, but the agent may still remember it.";
      const LOSS_IN_BAND = "This worker's earlier conversation is still shown above. This turn starts fresh.";
      const LOSS_SIDECAR =
        "This worker's earlier conversation could not be restored — a diagnostic copy of the record has been preserved. This turn starts fresh.";
      const LOSS_LOST = "This worker's earlier conversation could not be restored. This turn starts fresh.";

      async function renderFailure(preservation?: RestorePreservation, sdkResumed?: boolean) {
        globalThis.fetch = Object.assign(
          mock(
            makeEmbeddedViewFetch([
              embeddedAgentFixture({ engine: 'claude-sdk', provider: { model: 'claude-opus-4' } }),
            ]),
          ),
          { preconnect: () => {} },
        );
        const view = renderView({
          sessionId: `s-r4-${preservation ?? 'absent'}-${sdkResumed}`,
          workerId: `w-r4-${preservation ?? 'absent'}-${sdkResumed}`,
          embeddedAgentId: 'ea-1',
        });
        const ws = MockWebSocket.getLastInstance();
        act(() => {
          ws?.simulateOpen();
        });
        await flush();
        act(() => {
          ws?.simulateMessage(
            JSON.stringify({
              type: 'restore-info',
              epoch: 1,
              failed: true,
              ...(sdkResumed !== undefined ? { sdkResumed } : {}),
              ...(preservation !== undefined ? { preservation } : {}),
            }),
          );
        });
        await flush();
        return view;
      }

      it("D2, preservation 'in-band': the transcript IS the display, no separate copy claim", async () => {
        const view = await renderFailure('in-band', true);
        expect(within(view.container).getByText(D2_IN_BAND)).toBeTruthy();
        expect(within(view.container).queryByText(D2_SIDECAR)).toBeNull();
        expect(within(view.container).queryByText(D2_LOST)).toBeNull();
      });

      it("D2, preservation 'sidecar': claims a diagnostic copy was preserved", async () => {
        const view = await renderFailure('sidecar', true);
        expect(within(view.container).getByText(D2_SIDECAR)).toBeTruthy();
        expect(within(view.container).queryByText(D2_IN_BAND)).toBeNull();
        expect(within(view.container).queryByText(D2_LOST)).toBeNull();
      });

      it("D2, preservation 'lost': drops the diagnostic-copy claim -- nothing was preserved anywhere", async () => {
        const view = await renderFailure('lost', true);
        expect(within(view.container).getByText(D2_LOST)).toBeTruthy();
        expect(within(view.container).queryByText(D2_IN_BAND)).toBeNull();
        expect(within(view.container).queryByText(D2_SIDECAR)).toBeNull();
      });

      it("Loss, preservation 'in-band': the transcript IS the display, no separate copy claim", async () => {
        const view = await renderFailure('in-band', false);
        expect(within(view.container).getByText(LOSS_IN_BAND)).toBeTruthy();
        expect(within(view.container).queryByText(LOSS_SIDECAR)).toBeNull();
        expect(within(view.container).queryByText(LOSS_LOST)).toBeNull();
      });

      it("Loss, preservation 'sidecar': claims a diagnostic copy was preserved", async () => {
        const view = await renderFailure('sidecar', false);
        expect(within(view.container).getByText(LOSS_SIDECAR)).toBeTruthy();
        expect(within(view.container).queryByText(LOSS_IN_BAND)).toBeNull();
        expect(within(view.container).queryByText(LOSS_LOST)).toBeNull();
      });

      it("Loss, preservation 'lost': drops the diagnostic-copy claim -- nothing was preserved anywhere", async () => {
        const view = await renderFailure('lost', false);
        expect(within(view.container).getByText(LOSS_LOST)).toBeTruthy();
        expect(within(view.container).queryByText(LOSS_IN_BAND)).toBeNull();
        expect(within(view.container).queryByText(LOSS_SIDECAR)).toBeNull();
      });

      it("preservation absent (pre-stage-4 server, D2): renders today's unconditional copy unchanged", async () => {
        const view = await renderFailure(undefined, true);
        expect(within(view.container).getByText(D2_RE)).toBeTruthy();
        expect(within(view.container).queryByText(D2_IN_BAND)).toBeNull();
      });

      it("preservation absent (pre-stage-4 server, Loss): renders today's unconditional copy unchanged", async () => {
        const view = await renderFailure(undefined, false);
        expect(within(view.container).getByText(LOSS_RE)).toBeTruthy();
        expect(within(view.container).queryByText(LOSS_IN_BAND)).toBeNull();
      });
    });

    // Re-derived for R3 (#1447 stage 4), which changed WHAT clears
    // restoredMessageCount: it is no longer only resetChatState's epoch-bump
    // reset -- applyRestoreFailure now clears it unconditionally on every
    // accepted failure form. #1473's original single test exercised only
    // the FALLBACK (epoch-bump) route; it is kept below (renamed and its
    // stale "a real restore failure always mints a fresh epoch" premise
    // corrected), and a sibling test for the PRIMARY (in-band, no-epoch-bump)
    // route is added immediately after it -- together these are what
    // "record what replaced it" means here: the original assertion survives
    // unweakened on the route it was written for, and a second assertion now
    // covers the route R1 introduced.
    it('mutual exclusivity, FALLBACK route: D1 notice and the #1449 banners never co-render across a real epoch-transition sequence (condition 1)', async () => {
      globalThis.fetch = Object.assign(
        mock(
          makeEmbeddedViewFetch([
            embeddedAgentFixture({ engine: 'claude-sdk', provider: { model: 'claude-opus-4' } }),
          ]),
        ),
        { preconnect: () => {} },
      );
      renderView({ sessionId: 's-1449-excl', workerId: 'w-1449-excl', embeddedAgentId: 'ea-1' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });
      await flush();

      // Step 1: a SUCCESSFUL restore on epoch 1, resume did NOT take -> D1
      // fires on its own gate (hadPriorTranscriptThisIncarnation &&
      // sdkResumeFailed), independent of restoreFailed.
      act(() => {
        ws?.simulateMessage(
          JSON.stringify({
            type: 'restore-info',
            epoch: 1,
            restoredMessageCount: 5,
            repairedToolCallIds: [],
            completed: true,
            sdkResumed: false,
          }),
        );
      });
      await flush();
      expect(screen.getByText(D1_RE)).toBeTruthy();
      expect(screen.queryByText(D2_RE)).toBeNull();
      expect(screen.queryByText(LOSS_RE)).toBeNull();

      // Step 2: the worker restarts and THIS incarnation's restore FAILS on
      // the FALLBACK route -- a NEWER epoch (resetWorkerOutput minted a
      // fresh one), which resetChatState clears restoredMessageCount back to
      // null for BEFORE this failure message is applied (and
      // applyRestoreFailure's own R3 clear repeats that, redundantly but
      // harmlessly, on this route). D1's gate
      // (hadPriorTranscriptThisIncarnation) must therefore already be false
      // by the time the failure banner renders -- asserted here on the
      // actual rendered DOM, not assumed from the state shape.
      act(() => {
        ws?.simulateMessage(JSON.stringify({ type: 'restore-info', epoch: 2, failed: true, sdkResumed: false }));
      });
      await flush();
      expect(screen.queryByText(D1_RE)).toBeNull();
      expect(screen.getByText(LOSS_RE)).toBeTruthy();
      expect(screen.queryByText(D2_RE)).toBeNull();
    });

    it('mutual exclusivity, PRIMARY (in-band) route: D1 notice and the #1449 banners never co-render on the SAME epoch (R3)', async () => {
      globalThis.fetch = Object.assign(
        mock(
          makeEmbeddedViewFetch([
            embeddedAgentFixture({ engine: 'claude-sdk', provider: { model: 'claude-opus-4' } }),
          ]),
        ),
        { preconnect: () => {} },
      );
      renderView({ sessionId: 's-1449-excl-inband', workerId: 'w-1449-excl-inband', embeddedAgentId: 'ea-1' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });
      await flush();

      // Step 1: a SUCCESSFUL restore on epoch 1, resume did NOT take -> D1.
      act(() => {
        ws?.simulateMessage(
          JSON.stringify({
            type: 'restore-info',
            epoch: 1,
            restoredMessageCount: 5,
            repairedToolCallIds: [],
            completed: true,
            sdkResumed: false,
          }),
        );
      });
      await flush();
      expect(screen.getByText(D1_RE)).toBeTruthy();
      expect(screen.queryByText(D2_RE)).toBeNull();
      expect(screen.queryByText(LOSS_RE)).toBeNull();

      // Step 2: a LATER restore attempt on this SAME incarnation fails on
      // the PRIMARY (in-band) route -- SAME epoch, no epoch bump, so
      // resetChatState never runs. R3 is what makes this exclusive: without
      // applyRestoreFailure's own unconditional restoredMessageCount clear,
      // `hadPriorTranscriptThisIncarnation` (and therefore the D1 notice)
      // would still read true from epoch 1's success form, and D1 would
      // wrongly co-render alongside the failure banner below.
      act(() => {
        ws?.simulateMessage(
          JSON.stringify({ type: 'restore-info', epoch: 1, failed: true, sdkResumed: false, preservation: 'in-band' }),
        );
      });
      await flush();
      expect(screen.queryByText(D1_RE)).toBeNull();
      expect(screen.getByText("This worker's earlier conversation is still shown above. This turn starts fresh.")).toBeTruthy();
      expect(screen.queryByText(D2_RE)).toBeNull();
    });

    it('monotonicity: an optimistic sdkResumed:true failure push (D2) is later corrected to false (Loss), never reverts (condition 2)', async () => {
      globalThis.fetch = Object.assign(
        mock(
          makeEmbeddedViewFetch([
            embeddedAgentFixture({ engine: 'claude-sdk', provider: { model: 'claude-opus-4' } }),
          ]),
        ),
        { preconnect: () => {} },
      );
      renderView({ sessionId: 's-1449-mono', workerId: 'w-1449-mono', embeddedAgentId: 'ea-1' });
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });
      await flush();

      // Fast-path push: optimistic sdkResumed:true (resume attempted, not
      // yet known to have failed) -> D2.
      act(() => {
        ws?.simulateMessage(JSON.stringify({ type: 'restore-info', epoch: 1, failed: true, sdkResumed: true }));
      });
      await flush();
      expect(screen.getByText(D2_RE)).toBeTruthy();
      expect(screen.queryByText(LOSS_RE)).toBeNull();

      // R1 correction push: the SAME epoch, sdkResumed corrected downward to
      // false once the resume outcome is actually known -> Loss, and the D2
      // text must be gone.
      act(() => {
        ws?.simulateMessage(JSON.stringify({ type: 'restore-info', epoch: 1, failed: true, sdkResumed: false }));
      });
      await flush();
      expect(screen.getByText(LOSS_RE)).toBeTruthy();
      expect(screen.queryByText(D2_RE)).toBeNull();
    });

  });
});

describe('formatTokenCount', () => {
  it('leaves counts under a thousand alone', () => {
    expect(formatTokenCount(950)).toBe('950');
    expect(formatTokenCount(0)).toBe('0');
  });

  it('keeps one decimal below ten thousand, where the tenth is meaningful', () => {
    expect(formatTokenCount(2710)).toBe('2.7k');
    expect(formatTokenCount(1000)).toBe('1k');
  });

  it('drops the decimal above ten thousand, where it is noise', () => {
    expect(formatTokenCount(102150)).toBe('102k');
    expect(formatTokenCount(25335)).toBe('25k');
  });
});

describe('formatCompactionBoundaryLabel', () => {
  it('states what happened, with the numbers', () => {
    expect(formatCompactionBoundaryLabel(102150, 2710)).toBe(
      '— Context compacted (102k → 2.7k) —',
    );
  });

  it('never promises that anything was preserved -- in EITHER label shape', () => {
    // The line is a fact, not a guarantee: SDK-side fidelity is measured
    // non-deterministic, so a preservation claim would be falsified by a
    // single counterexample.
    //
    // Both shapes are checked deliberately. A polarity run found that
    // asserting only the with-numbers branch left the bare-marker fallback
    // unguarded -- which is the branch a future implementer is most likely to
    // "improve" with a reassuring clause, precisely because it has no numbers
    // to carry the meaning.
    const forbidden = /preserv|retain|kept|safe|nothing (is |was )?lost/;
    expect(formatCompactionBoundaryLabel(102150, 2710).toLowerCase()).not.toMatch(forbidden);
    expect(formatCompactionBoundaryLabel(undefined, undefined).toLowerCase()).not.toMatch(forbidden);
  });

  it('falls back to the bare marker when the engine supplied no figures', () => {
    expect(formatCompactionBoundaryLabel(undefined, undefined)).toBe('— Context compacted —');
    expect(formatCompactionBoundaryLabel(102150, undefined)).toBe('— Context compacted —');
    expect(formatCompactionBoundaryLabel(undefined, 2710)).toBe('— Context compacted —');
  });
});
