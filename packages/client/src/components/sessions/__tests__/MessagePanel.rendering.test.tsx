import { describe, it, expect, mock, afterEach } from 'bun:test';

const mockSendWorkerMessage = mock(() => Promise.resolve({ message: {} }));
mock.module('../../../lib/api', () => ({
  sendWorkerMessage: mockSendWorkerMessage,
}));

import { fireEvent, cleanup, act, within } from '@testing-library/react';
import { renderWithRouter } from '../../../test/renderWithRouter';
import { MessagePanel } from '../MessagePanel';

const defaultProps = {
  sessionId: 'session-1',
  targetWorkerId: 'agent-1',
  newMessage: null,
};

describe('MessagePanel', () => {
  afterEach(() => {
    cleanup();
    mockSendWorkerMessage.mockClear();
  });

  it('renders send form with textarea and send button', async () => {
    const { container } = await act(async () => renderWithRouter(<MessagePanel {...defaultProps} />));
    const view = within(container);

    expect(view.getByPlaceholderText('Send message to worker... (Ctrl+Enter to send)')).toBeTruthy();
    expect(view.getByText('Send')).toBeTruthy();
  });

  it('renders file attach button', async () => {
    const { container } = await act(async () => renderWithRouter(<MessagePanel {...defaultProps} />));
    const view = within(container);

    expect(view.getByLabelText('Attach files')).toBeTruthy();
  });

  it('does not show file chips initially', async () => {
    const { container } = await act(async () => renderWithRouter(<MessagePanel {...defaultProps} />));

    // No remove buttons means no file chips
    expect(container.querySelector('[aria-label^="Remove"]')).toBeNull();
  });

  it('does not render a target worker dropdown', async () => {
    const { container } = await act(async () => renderWithRouter(<MessagePanel {...defaultProps} />));
    const view = within(container);

    expect(view.queryByRole('combobox')).toBeNull();
  });

  it('Send button is disabled when textarea is empty', async () => {
    const { container } = await act(async () => renderWithRouter(<MessagePanel {...defaultProps} />));
    const view = within(container);

    const button = view.getByText('Send') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('Ctrl+Enter triggers send', async () => {
    const { container } = await act(async () => renderWithRouter(<MessagePanel {...defaultProps} />));
    const view = within(container);

    const textarea = view.getByPlaceholderText('Send message to worker... (Ctrl+Enter to send)');
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'hello' } });
    });
    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    });

    expect(mockSendWorkerMessage).toHaveBeenCalledWith('session-1', 'agent-1', 'hello', undefined);
  });

  it('Cmd+Enter triggers send', async () => {
    const { container } = await act(async () => renderWithRouter(<MessagePanel {...defaultProps} />));
    const view = within(container);

    const textarea = view.getByPlaceholderText('Send message to worker... (Ctrl+Enter to send)');
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'hello' } });
    });
    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
    });

    expect(mockSendWorkerMessage).toHaveBeenCalledWith('session-1', 'agent-1', 'hello', undefined);
  });

  it('clears content and files when targetWorkerId changes', async () => {
    const { container, rerender } = await act(async () =>
      renderWithRouter(<MessagePanel {...defaultProps} />),
    );
    const view = within(container);

    // Type something
    const textarea = view.getByPlaceholderText('Send message to worker... (Ctrl+Enter to send)');
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'draft message' } });
    });
    expect((textarea as HTMLTextAreaElement).value).toBe('draft message');

    // Change target worker
    await act(async () => {
      rerender(<MessagePanel {...defaultProps} targetWorkerId="agent-2" />);
    });

    const updatedTextarea = view.getByPlaceholderText('Send message to worker... (Ctrl+Enter to send)');
    expect((updatedTextarea as HTMLTextAreaElement).value).toBe('');
  });

  it('shows unread indicator only for messages to this target worker', async () => {
    const message = {
      id: 'msg-1',
      sessionId: 'session-1',
      fromWorkerId: 'agent-2',
      fromWorkerName: 'Agent 2',
      toWorkerId: 'agent-1',
      toWorkerName: 'Agent 1',
      content: 'hello',
      timestamp: new Date().toISOString(),
    };

    const { container, rerender } = await act(async () =>
      renderWithRouter(<MessagePanel {...defaultProps} newMessage={null} />),
    );

    // Message to a different worker should NOT show indicator
    const otherMessage = { ...message, toWorkerId: 'agent-99' };
    await act(async () => {
      rerender(<MessagePanel {...defaultProps} newMessage={otherMessage} />);
    });
    expect(container.querySelector('.bg-blue-500')).toBeNull();

    // Message to this target worker SHOULD show indicator
    await act(async () => {
      rerender(<MessagePanel {...defaultProps} newMessage={message} />);
    });
    expect(container.querySelector('.bg-blue-500')).toBeTruthy();
  });

  it('clears unread indicator when targetWorkerId changes', async () => {
    const message = {
      id: 'msg-1',
      sessionId: 'session-1',
      fromWorkerId: 'agent-2',
      fromWorkerName: 'Agent 2',
      toWorkerId: 'agent-1',
      toWorkerName: 'Agent 1',
      content: 'hello',
      timestamp: new Date().toISOString(),
    };

    const { container, rerender } = await act(async () =>
      renderWithRouter(<MessagePanel {...defaultProps} newMessage={message} />),
    );
    expect(container.querySelector('.bg-blue-500')).toBeTruthy();

    // Switch target worker - should clear unread
    await act(async () => {
      rerender(<MessagePanel {...defaultProps} targetWorkerId="agent-2" newMessage={message} />);
    });
    expect(container.querySelector('.bg-blue-500')).toBeNull();
  });

  it('Enter alone does NOT send', async () => {
    const { container } = await act(async () => renderWithRouter(<MessagePanel {...defaultProps} />));
    const view = within(container);

    const textarea = view.getByPlaceholderText('Send message to worker... (Ctrl+Enter to send)');
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'hello' } });
    });
    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter' });
    });

    expect(mockSendWorkerMessage).not.toHaveBeenCalled();
  });
});
