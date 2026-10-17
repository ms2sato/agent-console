import { describe, it, expect, mock, beforeEach, afterEach, afterAll, spyOn } from 'bun:test';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { RunCommandDialog } from '../RunCommandDialog';
import { codeBlockCopyText } from '../../ui/MarkdownCodeBlock';
import type { SessionTerminalRun } from '../SessionTerminalRunContext';

// Fetch-boundary mock: sendWorkerMessage is the real client function; only the
// network is faked. `events` records the cross-call order (create vs. send).
const originalFetch = globalThis.fetch;
const mockFetch = mock((_url: unknown, _init?: RequestInit) => Promise.resolve(new Response()));
globalThis.fetch = Object.assign(mockFetch, { preconnect: () => {} }) as typeof fetch;
afterAll(() => {
  globalThis.fetch = originalFetch;
});

let events: string[];

function sendCalls(): Array<{ url: string; toWorkerId: string; content: string }> {
  return (mockFetch.mock.calls as unknown[][])
    .filter((c) => String(c[0]).includes('/messages'))
    .map((c) => {
      const body = (c[1] as RequestInit).body as FormData;
      return { url: String(c[0]), toWorkerId: String(body.get('toWorkerId')), content: String(body.get('content')) };
    });
}

function makeRun(
  workers: Array<{ id: string; name: string }>,
  overrides: Partial<SessionTerminalRun> = {},
): SessionTerminalRun {
  return {
    terminalWorkers: workers,
    activateWorker: mock((id: string) => {
      events.push(`activate:${id}`);
    }),
    createTerminalWorker: mock(async () => {
      events.push('create');
      return { id: 'new-term', name: 'Shell 1' };
    }),
    ...overrides,
  };
}

function renderDialog(command: string, run: SessionTerminalRun, onClose = mock(() => {})) {
  render(<RunCommandDialog sessionId="session-1" command={command} terminalRun={run} onClose={onClose} />);
  return onClose;
}

describe('RunCommandDialog', () => {
  let consoleErrorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    events = [];
    mockFetch.mockReset();
    mockFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
      if (String(url).includes('/messages')) {
        events.push(`send:${String((init?.body as FormData).get('toWorkerId'))}`);
      }
      return new Response(JSON.stringify({ message: { id: 'm1', sessionId: 's1', fromWorkerId: 'w1', fromWorkerName: 'A', toWorkerId: 'w2', toWorkerName: 'B', content: 'x', timestamp: '2026-01-01T00:00:00.000Z' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    consoleErrorSpy.mockRestore();
  });

  it('shows the full command verbatim in a monospace block, plus the single target terminal name', () => {
    const command = 'echo "$HOME" `date` \\\n  && ls -la ' + 'x'.repeat(400);
    renderDialog(command, makeRun([{ id: 't1', name: 'Build shell' }]));

    const text = screen.getByTestId('run-command-text');
    expect(text.textContent).toBe(command);
    expect(text.className).toContain('font-mono');
    expect(screen.getByTestId('run-command-target').textContent).toBe('Build shell');
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('shows exactly the Copy text, including backticks, $ and the trailing-newline trim', () => {
    const copyText = codeBlockCopyText('echo `id` $(whoami) $HOME\n');
    renderDialog(copyText, makeRun([{ id: 't1', name: 'Shell 1' }]));

    expect(screen.getByTestId('run-command-text').textContent).toBe('echo `id` $(whoami) $HOME');
  });

  it('confirm sends exactly one message with the command and the target id, then activates it and closes', async () => {
    const run = makeRun([{ id: 't1', name: 'Shell 1' }]);
    const onClose = renderDialog('npm test', run);

    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(sendCalls()).toEqual([
      { url: expect.stringContaining('/sessions/session-1/messages'), toWorkerId: 't1', content: 'npm test' },
    ]);
    expect(run.activateWorker).toHaveBeenCalledWith('t1');
    expect(events).toEqual(['send:t1', 'activate:t1']);
    expect(run.createTerminalWorker).not.toHaveBeenCalled();
  });

  it('sends a multi-line block as ONE call, newlines intact', async () => {
    const script = 'set -e\ncd /tmp/work\nbun run build';
    const onClose = renderDialog(script, makeRun([{ id: 't1', name: 'Shell 1' }]));

    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(sendCalls()).toHaveLength(1);
    expect(sendCalls()[0].content).toBe(script);
  });

  it('cancel never sends, never creates, never activates', async () => {
    const run = makeRun([{ id: 't1', name: 'Shell 1' }]);
    const onClose = renderDialog('rm -rf build', run);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(sendCalls()).toHaveLength(0);
    expect(run.createTerminalWorker).not.toHaveBeenCalled();
    expect(run.activateWorker).not.toHaveBeenCalled();
  });

  it('with several terminals offers a select, defaulting to the first, and sends to the chosen id', async () => {
    const run = makeRun([
      { id: 't1', name: 'Shell 1' },
      { id: 't2', name: 'Shell 2' },
    ]);
    const onClose = renderDialog('ls', run);

    const select = screen.getByRole('combobox', { name: 'Target terminal' }) as HTMLSelectElement;
    expect(select.value).toBe('t1');
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['Shell 1', 'Shell 2']);

    fireEvent.change(select, { target: { value: 't2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(sendCalls().map((c) => c.toWorkerId)).toEqual(['t2']);
    expect(run.activateWorker).toHaveBeenCalledWith('t2');
  });

  it('with no terminal creates one first, THEN sends to the new worker id (order asserted), without a second activation', async () => {
    const run = makeRun([]);
    const onClose = renderDialog('ls', run);

    expect(screen.getByTestId('run-command-target').textContent).toContain('new terminal');
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(events).toEqual(['create', 'send:new-term']);
    expect(run.activateWorker).not.toHaveBeenCalled();
  });

  it('when creating the terminal yields nothing, sends nothing and closes (the failure was already surfaced)', async () => {
    const run = makeRun([], { createTerminalWorker: mock(async () => null) });
    const onClose = renderDialog('ls', run);

    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(sendCalls()).toHaveLength(0);
  });

  it('keeps the dialog open and shows the error when the send fails, without activating', async () => {
    mockFetch.mockImplementation(async () => new Response(JSON.stringify({ error: 'pty gone' }), { status: 500 }));
    const run = makeRun([{ id: 't1', name: 'Shell 1' }]);
    const onClose = renderDialog('ls', run);

    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(run.activateWorker).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Run' })).toBeTruthy();
  });

  it('keeps the dialog open and shows the error when creating the terminal throws, without sending', async () => {
    const run = makeRun([], { createTerminalWorker: mock(async () => { throw new Error('create failed'); }) });
    const onClose = renderDialog('ls', run);

    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    expect((await screen.findByRole('alert')).textContent).toBe('create failed');
    expect(sendCalls()).toHaveLength(0);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a double click on Run sends once', async () => {
    const onClose = renderDialog('ls', makeRun([{ id: 't1', name: 'Shell 1' }]));
    const run = screen.getByRole('button', { name: 'Run' });

    fireEvent.click(run);
    fireEvent.click(run);

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(sendCalls()).toHaveLength(1);
  });
});
