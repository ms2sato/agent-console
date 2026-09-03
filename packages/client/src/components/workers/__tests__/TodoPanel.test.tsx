import { describe, it, expect, afterEach } from 'bun:test';
import { render, screen, cleanup } from '@testing-library/react';
import { TodoPanel } from '../TodoPanel';
import type { EmbeddedAgentChatEntry } from '../embedded-agent-store';

afterEach(() => {
  cleanup();
});

function toolCall(
  callId: string,
  args: unknown,
  result: { ok: boolean; result: string } | null,
): EmbeddedAgentChatEntry {
  return {
    key: `tc-${callId}`,
    kind: 'tool-call',
    turnId: 't1',
    callId,
    name: 'TodoWrite',
    args,
    result,
  };
}

describe('TodoPanel', () => {
  it('renders nothing when entries contains no TodoWrite entry', () => {
    const entries: EmbeddedAgentChatEntry[] = [
      { key: 'u1', kind: 'user-message', id: 'u1', text: 'hello' },
      { key: 'a1', kind: 'assistant-message', turnId: 't1', text: 'hi', streaming: false },
    ];

    const { container } = render(<TodoPanel entries={entries} />);

    expect(container.querySelector('details')).toBeNull();
    expect(screen.queryByText(/Tasks \(/)).toBeNull();
  });

  it('renders nothing when the latest ok TodoWrite entry cleared the list to zero items', () => {
    const entries: EmbeddedAgentChatEntry[] = [
      toolCall('c1', { todos: [] }, { ok: true, result: 'ok' }),
    ];

    const { container } = render(<TodoPanel entries={entries} />);

    expect(container.querySelector('details')).toBeNull();
    expect(screen.queryByText(/Tasks \(/)).toBeNull();
  });

  it('renders the list with status glyphs and shows activeForm (not content) for the in_progress item', () => {
    const entries: EmbeddedAgentChatEntry[] = [
      toolCall(
        'c1',
        {
          todos: [
            { content: 'Write tests', status: 'pending', activeForm: 'Writing tests' },
            { content: 'Run tests', status: 'in_progress', activeForm: 'Running tests' },
            { content: 'Ship it', status: 'completed', activeForm: 'Shipping it' },
          ],
        },
        { ok: true, result: 'Todo list updated: 3 items (1 pending, 1 in progress, 1 completed)' },
      ),
    ];

    render(<TodoPanel entries={entries} />);

    // in_progress -> activeForm shown, not content
    expect(screen.getByText('Running tests')).toBeTruthy();
    expect(screen.queryByText('Run tests')).toBeNull();

    // pending / completed -> content shown
    expect(screen.getByText('Write tests')).toBeTruthy();
    expect(screen.getByText('Ship it')).toBeTruthy();
  });

  it('shows the SECOND list (not a merge) when a later ok TodoWrite entry supersedes an earlier one', () => {
    const entries: EmbeddedAgentChatEntry[] = [
      toolCall(
        'c1',
        { todos: [{ content: 'First task', status: 'pending', activeForm: 'Doing first task' }] },
        { ok: true, result: 'ok' },
      ),
      toolCall(
        'c2',
        { todos: [{ content: 'Second task', status: 'pending', activeForm: 'Doing second task' }] },
        { ok: true, result: 'ok' },
      ),
    ];

    render(<TodoPanel entries={entries} />);

    expect(screen.getByText('Second task')).toBeTruthy();
    expect(screen.queryByText('First task')).toBeNull();
  });

  it('keeps showing the earlier ok list when a later TodoWrite entry failed (ok: false)', () => {
    const entries: EmbeddedAgentChatEntry[] = [
      toolCall(
        'c1',
        { todos: [{ content: 'Surviving task', status: 'pending', activeForm: 'Doing surviving task' }] },
        { ok: true, result: 'ok' },
      ),
      toolCall(
        'c2',
        { todos: [{ content: 'Rejected task', status: 'pending', activeForm: 'Doing rejected task' }] },
        { ok: false, result: 'invalid input' },
      ),
    ];

    render(<TodoPanel entries={entries} />);

    expect(screen.getByText('Surviving task')).toBeTruthy();
    expect(screen.queryByText('Rejected task')).toBeNull();
  });

  it('renders <details> closed by default when all items are completed, with a correct summary line', () => {
    const entries: EmbeddedAgentChatEntry[] = [
      toolCall(
        'c1',
        {
          todos: [
            { content: 'Task A', status: 'completed', activeForm: 'Doing task A' },
            { content: 'Task B', status: 'completed', activeForm: 'Doing task B' },
            { content: 'Task C', status: 'completed', activeForm: 'Doing task C' },
          ],
        },
        { ok: true, result: 'ok' },
      ),
    ];

    const { container } = render(<TodoPanel entries={entries} />);

    const details = container.querySelector('details');
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    expect(screen.getByText('Tasks (3/3 completed)')).toBeTruthy();
  });

  it('renders <details> open by default when not all items are completed', () => {
    const entries: EmbeddedAgentChatEntry[] = [
      toolCall(
        'c1',
        {
          todos: [
            { content: 'Task A', status: 'completed', activeForm: 'Doing task A' },
            { content: 'Task B', status: 'pending', activeForm: 'Doing task B' },
          ],
        },
        { ok: true, result: 'ok' },
      ),
    ];

    const { container } = render(<TodoPanel entries={entries} />);

    const details = container.querySelector('details');
    expect(details).not.toBeNull();
    expect(details?.open).toBe(true);
    expect(screen.getByText('Tasks (1/2 completed)')).toBeTruthy();
  });
});
