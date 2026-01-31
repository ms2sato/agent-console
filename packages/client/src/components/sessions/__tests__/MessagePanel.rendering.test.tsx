import { describe, it, expect, mock, afterEach } from 'bun:test';

const mockSendWorkerMessage = mock(() => Promise.resolve({ message: {} }));
mock.module('../../../lib/api', () => ({
  sendWorkerMessage: mockSendWorkerMessage,
}));

import { screen, fireEvent, cleanup, act } from '@testing-library/react';
import { renderWithRouter } from '../../../test/renderWithRouter';
import { MessagePanel } from '../MessagePanel';

const agentWorker1 = { id: 'agent-1', name: 'Claude Code 1', type: 'agent' as const, agentId: 'claude-code', createdAt: '2024-01-01', status: 'active' as const, activated: true };
const agentWorker2 = { id: 'agent-2', name: 'Claude Code 2', type: 'agent' as const, agentId: 'claude-code', createdAt: '2024-01-01', status: 'active' as const, activated: true };
const terminalWorker = { id: 'term-1', name: 'Shell 1', type: 'terminal' as const, createdAt: '2024-01-01', activated: true };
const gitDiffWorker = { id: 'diff-1', name: 'Diff', type: 'git-diff' as const, createdAt: '2024-01-01', baseCommit: 'abc123' };

const defaultProps = {
  sessionId: 'session-1',
  workers: [agentWorker1, agentWorker2, terminalWorker, gitDiffWorker],
  activeWorkerId: 'agent-1',
  newMessage: null,
};

describe('MessagePanel', () => {
  afterEach(() => {
    cleanup();
    mockSendWorkerMessage.mockClear();
  });

  it('renders disabled state when no agent workers', async () => {
    await act(async () => {
      await renderWithRouter(
        <MessagePanel
          sessionId="session-1"
          workers={[terminalWorker, gitDiffWorker]}
          activeWorkerId="term-1"
          newMessage={null}
        />
      );
    });

    const input = screen.getByPlaceholderText('No agent workers available');
    expect(input).toBeTruthy();
    expect((input as HTMLInputElement).disabled).toBe(true);
  });

  it('renders send form when agent workers exist', async () => {
    await act(async () => {
      await renderWithRouter(<MessagePanel {...defaultProps} />);
    });

    expect(screen.getByRole('combobox')).toBeTruthy();
    expect(screen.getByPlaceholderText('Send message to worker... (Ctrl+Enter to send)')).toBeTruthy();
    expect(screen.getByText('Send')).toBeTruthy();
  });

  it('only shows agent workers in select dropdown', async () => {
    await act(async () => {
      await renderWithRouter(<MessagePanel {...defaultProps} />);
    });

    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(2);
    expect(options[0].textContent).toBe('Claude Code 1');
    expect(options[1].textContent).toBe('Claude Code 2');
  });

  it('defaults target to activeWorkerId when it is an agent', async () => {
    await act(async () => {
      await renderWithRouter(<MessagePanel {...defaultProps} activeWorkerId="agent-2" />);
    });

    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBe('agent-2');
  });

  it('falls back to first agent when activeWorkerId is a non-agent worker (terminal)', async () => {
    await act(async () => {
      await renderWithRouter(<MessagePanel {...defaultProps} activeWorkerId="term-1" />);
    });

    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBe('agent-1');
  });

  it('falls back to first agent when activeWorkerId is a non-agent worker (git-diff)', async () => {
    await act(async () => {
      await renderWithRouter(<MessagePanel {...defaultProps} activeWorkerId="diff-1" />);
    });

    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBe('agent-1');
  });

  it('Send button is disabled when textarea is empty', async () => {
    await act(async () => {
      await renderWithRouter(<MessagePanel {...defaultProps} />);
    });

    const button = screen.getByText('Send') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('Ctrl+Enter triggers send', async () => {
    await act(async () => {
      await renderWithRouter(<MessagePanel {...defaultProps} />);
    });

    const textarea = screen.getByPlaceholderText('Send message to worker... (Ctrl+Enter to send)');
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'hello' } });
    });
    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    });

    expect(mockSendWorkerMessage).toHaveBeenCalledWith('session-1', 'agent-1', 'hello');
  });

  it('Cmd+Enter triggers send', async () => {
    await act(async () => {
      await renderWithRouter(<MessagePanel {...defaultProps} />);
    });

    const textarea = screen.getByPlaceholderText('Send message to worker... (Ctrl+Enter to send)');
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'hello' } });
    });
    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
    });

    expect(mockSendWorkerMessage).toHaveBeenCalledWith('session-1', 'agent-1', 'hello');
  });

  it('Enter alone does NOT send', async () => {
    await act(async () => {
      await renderWithRouter(<MessagePanel {...defaultProps} />);
    });

    const textarea = screen.getByPlaceholderText('Send message to worker... (Ctrl+Enter to send)');
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'hello' } });
    });
    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter' });
    });

    expect(mockSendWorkerMessage).not.toHaveBeenCalled();
  });
});
