import { describe, it, expect, mock, afterEach, beforeEach } from 'bun:test';

const mockSendWorkerMessage = mock(() => Promise.resolve({
  message: {
    id: 'msg-1',
    sessionId: 'session-1',
    fromWorkerId: 'user',
    fromWorkerName: 'User',
    toWorkerId: 'agent-1',
    toWorkerName: 'Agent 1',
    content: 'hello',
    timestamp: new Date().toISOString(),
  },
}));
mock.module('../../../lib/api', () => ({
  sendWorkerMessage: mockSendWorkerMessage,
}));

const mockSendInput = mock(() => true);
mock.module('../../../lib/worker-websocket', () => ({
  sendInput: mockSendInput,
}));

import { fireEvent, cleanup, act, within } from '@testing-library/react';
import { renderWithRouter } from '../../../test/renderWithRouter';
import { MessagePanel, canSend, validateFiles } from '../MessagePanel';
import { _getDraftsMap } from '../../../hooks/useDraftMessage';

describe('MessagePanel logic', () => {
  describe('canSend', () => {
    it('should return true when all conditions are met', () => {
      expect(canSend('worker1', 'Hello', false, 0)).toBe(true);
    });

    it('should return false when content is empty', () => {
      expect(canSend('worker1', '', false, 0)).toBe(false);
    });

    it('should return false when content is only whitespace', () => {
      expect(canSend('worker1', '   ', false, 0)).toBe(false);
    });

    it('should return false when targetWorkerId is empty', () => {
      expect(canSend('', 'Hello', false, 0)).toBe(false);
    });

    it('should return false when sending is true', () => {
      expect(canSend('worker1', 'Hello', true, 0)).toBe(false);
    });

    it('should return false when both content is empty and sending is true', () => {
      expect(canSend('worker1', '', true, 0)).toBe(false);
    });

    it('should return false when targetWorkerId is empty and content is valid', () => {
      expect(canSend('', 'Hello', false, 0)).toBe(false);
    });

    it('should return true when content has leading/trailing whitespace but is not empty', () => {
      expect(canSend('worker1', '  Hello  ', false, 0)).toBe(true);
    });

    it('should return false when all conditions fail', () => {
      expect(canSend('', '', true, 0)).toBe(false);
    });

    it('should return true when content is empty but files are attached', () => {
      expect(canSend('worker1', '', false, 1)).toBe(true);
    });

    it('should return false when files are attached but sending is true', () => {
      expect(canSend('worker1', '', true, 2)).toBe(false);
    });
  });

  describe('validateFiles', () => {
    it('should return null when files are within limits', () => {
      expect(validateFiles({ length: 5, totalSize: 1024 })).toBeNull();
    });

    it('should return null when no files', () => {
      expect(validateFiles({ length: 0, totalSize: 0 })).toBeNull();
    });

    it('should return error when file count exceeds maximum', () => {
      const result = validateFiles({ length: 11, totalSize: 100 });
      expect(result).not.toBeNull();
      expect(result![0]).toBe('Too Many Files');
    });

    it('should return error when total size exceeds maximum', () => {
      const result = validateFiles({ length: 1, totalSize: 11 * 1024 * 1024 });
      expect(result).not.toBeNull();
      expect(result![0]).toBe('File Size Limit');
    });

    it('should check file count before size', () => {
      const result = validateFiles({ length: 11, totalSize: 11 * 1024 * 1024 });
      expect(result![0]).toBe('Too Many Files');
    });

    it('should return null at exact limits', () => {
      expect(validateFiles({ length: 10, totalSize: 10 * 1024 * 1024 })).toBeNull();
    });
  });
});

const defaultProps = {
  sessionId: 'session-1',
  targetWorkerId: 'agent-1',
  newMessage: null,
};

describe('MessagePanel', () => {
  beforeEach(() => {
    _getDraftsMap().clear();
  });

  afterEach(() => {
    cleanup();
    mockSendWorkerMessage.mockClear();
    mockSendInput.mockClear();
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

  it('Ctrl+Enter triggers send via HTTP', async () => {
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

  it('Cmd+Enter triggers send via HTTP', async () => {
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

  it('resets textarea height after sending', async () => {
    const { container } = await act(async () => renderWithRouter(<MessagePanel {...defaultProps} />));
    const view = within(container);

    const textarea = view.getByPlaceholderText('Send message to worker... (Ctrl+Enter to send)') as HTMLTextAreaElement;
    // Simulate expanded height
    textarea.style.height = '100px';

    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'hello' } });
    });
    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    });

    expect(textarea.style.height).toBe('auto');
  });

  it('resets textarea height when targetWorkerId changes', async () => {
    const { container, rerender } = await act(async () =>
      renderWithRouter(<MessagePanel {...defaultProps} />),
    );
    const view = within(container);

    const textarea = view.getByPlaceholderText('Send message to worker... (Ctrl+Enter to send)') as HTMLTextAreaElement;
    textarea.style.height = '100px';

    await act(async () => {
      rerender(<MessagePanel {...defaultProps} targetWorkerId="agent-2" />);
    });

    // Re-query after rerender since DOM element may be replaced
    const updatedTextarea = view.getByPlaceholderText('Send message to worker... (Ctrl+Enter to send)') as HTMLTextAreaElement;
    expect(updatedTextarea.style.height).toBe('auto');
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

  it('restores draft when switching back to a previous worker', async () => {
    const { container, rerender } = await act(async () =>
      renderWithRouter(<MessagePanel {...defaultProps} />),
    );
    const view = within(container);

    // Type a draft for agent-1
    const textarea = view.getByPlaceholderText('Send message to worker... (Ctrl+Enter to send)');
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'draft for agent-1' } });
    });
    expect((textarea as HTMLTextAreaElement).value).toBe('draft for agent-1');

    // Switch to agent-2 -- content should be empty (no draft saved for agent-2)
    await act(async () => {
      rerender(<MessagePanel {...defaultProps} targetWorkerId="agent-2" />);
    });
    const textarea2 = view.getByPlaceholderText('Send message to worker... (Ctrl+Enter to send)');
    expect((textarea2 as HTMLTextAreaElement).value).toBe('');

    // Switch back to agent-1 -- draft should be restored
    await act(async () => {
      rerender(<MessagePanel {...defaultProps} targetWorkerId="agent-1" />);
    });
    const textarea3 = view.getByPlaceholderText('Send message to worker... (Ctrl+Enter to send)');
    expect((textarea3 as HTMLTextAreaElement).value).toBe('draft for agent-1');
  });

  it('ESC key sends escape character to PTY via WebSocket', async () => {
    const { container } = await act(async () => renderWithRouter(<MessagePanel {...defaultProps} />));
    const view = within(container);

    const textarea = view.getByPlaceholderText('Send message to worker... (Ctrl+Enter to send)');
    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Escape' });
    });

    expect(mockSendInput).toHaveBeenCalledWith('session-1', 'agent-1', '\x1b');
  });

  it('ESC key preserves draft content in textarea', async () => {
    const { container } = await act(async () => renderWithRouter(<MessagePanel {...defaultProps} />));
    const view = within(container);

    const textarea = view.getByPlaceholderText('Send message to worker... (Ctrl+Enter to send)');
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'my draft' } });
    });
    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Escape' });
    });

    expect((textarea as HTMLTextAreaElement).value).toBe('my draft');
    expect(mockSendInput).toHaveBeenCalledWith('session-1', 'agent-1', '\x1b');
  });

  it('ESC key does not trigger HTTP message send', async () => {
    const { container } = await act(async () => renderWithRouter(<MessagePanel {...defaultProps} />));
    const view = within(container);

    const textarea = view.getByPlaceholderText('Send message to worker... (Ctrl+Enter to send)');
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'hello' } });
    });
    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Escape' });
    });

    expect(mockSendWorkerMessage).not.toHaveBeenCalled();
  });

  it('clears draft on successful send', async () => {
    const { container } = await act(async () => renderWithRouter(<MessagePanel {...defaultProps} />));
    const view = within(container);

    // Type a message
    const textarea = view.getByPlaceholderText('Send message to worker... (Ctrl+Enter to send)');
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'message to send' } });
    });
    expect((textarea as HTMLTextAreaElement).value).toBe('message to send');
    // Verify draft is stored in the map
    expect(_getDraftsMap().get('session-1:agent-1')).toBe('message to send');

    // Send via Ctrl+Enter
    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    });

    // Content should be cleared
    expect((textarea as HTMLTextAreaElement).value).toBe('');
    // Draft should be removed from the map
    expect(_getDraftsMap().has('session-1:agent-1')).toBe(false);
  });

});
