import { describe, it, expect, mock, afterEach, beforeEach } from 'bun:test';

const TEST_SKILLS = [
  { name: '/commit', description: 'Create a git commit' },
  { name: '/review-loop', description: 'Run automated review loop' },
  { name: '/code-review', description: 'Review a pull request' },
  { name: '/simplify', description: 'Review and simplify changed code' },
  { name: '/orchestrator', description: 'Strategic task orchestration' },
  { name: '/schedule', description: 'Manage scheduled agents' },
  { name: '/loop', description: 'Run a command on recurring interval' },
];

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
const mockFetchSkills = mock(() => Promise.resolve({ skills: TEST_SKILLS }));
const mockFetchMessageTemplates = mock(() => Promise.resolve({ templates: [] }));
const mockCreateMessageTemplate = mock(() => Promise.resolve({ template: {} }));
const mockUpdateMessageTemplate = mock(() => Promise.resolve({ template: {} }));
const mockDeleteMessageTemplate = mock(() => Promise.resolve({ success: true }));
const mockReorderMessageTemplates = mock(() => Promise.resolve({ success: true }));
mock.module('../../../lib/api', () => ({
  sendWorkerMessage: mockSendWorkerMessage,
  fetchSkills: mockFetchSkills,
  fetchMessageTemplates: mockFetchMessageTemplates,
  createMessageTemplate: mockCreateMessageTemplate,
  updateMessageTemplate: mockUpdateMessageTemplate,
  deleteMessageTemplate: mockDeleteMessageTemplate,
  reorderMessageTemplates: mockReorderMessageTemplates,
}));

const mockSendInput = mock(() => true);
mock.module('../../../lib/worker-websocket', () => ({
  sendInput: mockSendInput,
}));

import { fireEvent, cleanup, act, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
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

/** Wrap component with QueryClientProvider for rerender calls (RTL's rerender loses the provider tree). */
function withProviders(queryClient: QueryClient, ui: React.ReactNode) {
  return <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>;
}

describe('MessagePanel', () => {
  beforeEach(() => {
    _getDraftsMap().clear();
  });

  afterEach(() => {
    cleanup();
    mockSendWorkerMessage.mockClear();
    mockFetchSkills.mockClear();
    mockSendInput.mockClear();
    mockFetchMessageTemplates.mockClear();
    mockCreateMessageTemplate.mockClear();
    mockUpdateMessageTemplate.mockClear();
    mockDeleteMessageTemplate.mockClear();
    mockReorderMessageTemplates.mockClear();
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
    const { container, rerender, queryClient } = await act(async () =>
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
      rerender(withProviders(queryClient, <MessagePanel {...defaultProps} targetWorkerId="agent-2" />));
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

    const { container, rerender, queryClient } = await act(async () =>
      renderWithRouter(<MessagePanel {...defaultProps} newMessage={null} />),
    );

    // Message to a different worker should NOT show indicator
    const otherMessage = { ...message, toWorkerId: 'agent-99' };
    await act(async () => {
      rerender(withProviders(queryClient, <MessagePanel {...defaultProps} newMessage={otherMessage} />));
    });
    expect(container.querySelector('.bg-blue-500')).toBeNull();

    // Message to this target worker SHOULD show indicator
    await act(async () => {
      rerender(withProviders(queryClient, <MessagePanel {...defaultProps} newMessage={message} />));
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

    const { container, rerender, queryClient } = await act(async () =>
      renderWithRouter(<MessagePanel {...defaultProps} newMessage={message} />),
    );
    expect(container.querySelector('.bg-blue-500')).toBeTruthy();

    // Switch target worker - should clear unread
    await act(async () => {
      rerender(withProviders(queryClient, <MessagePanel {...defaultProps} targetWorkerId="agent-2" newMessage={message} />));
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
    const { container, rerender, queryClient } = await act(async () =>
      renderWithRouter(<MessagePanel {...defaultProps} />),
    );
    const view = within(container);

    const textarea = view.getByPlaceholderText('Send message to worker... (Ctrl+Enter to send)') as HTMLTextAreaElement;
    textarea.style.height = '100px';

    await act(async () => {
      rerender(withProviders(queryClient, <MessagePanel {...defaultProps} targetWorkerId="agent-2" />));
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
    const { container, rerender, queryClient } = await act(async () =>
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
      rerender(withProviders(queryClient, <MessagePanel {...defaultProps} targetWorkerId="agent-2" />));
    });
    const textarea2 = view.getByPlaceholderText('Send message to worker... (Ctrl+Enter to send)');
    expect((textarea2 as HTMLTextAreaElement).value).toBe('');

    // Switch back to agent-1 -- draft should be restored
    await act(async () => {
      rerender(withProviders(queryClient, <MessagePanel {...defaultProps} targetWorkerId="agent-1" />));
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

  it('paste with image files adds them to file list', async () => {
    const { container } = await act(async () => renderWithRouter(<MessagePanel {...defaultProps} />));
    const view = within(container);

    const textarea = view.getByPlaceholderText('Send message to worker... (Ctrl+Enter to send)');
    const mockFile = new File(['image-data'], 'test.png', { type: 'image/png' });

    await act(async () => {
      fireEvent.paste(textarea, {
        clipboardData: {
          items: [
            { type: 'image/png', getAsFile: () => mockFile },
          ],
        },
      });
    });

    expect(container.querySelector('[aria-label="Remove test.png"]')).toBeTruthy();
  });

  it('paste without images does not affect file list', async () => {
    const { container } = await act(async () => renderWithRouter(<MessagePanel {...defaultProps} />));
    const view = within(container);

    const textarea = view.getByPlaceholderText('Send message to worker... (Ctrl+Enter to send)');

    await act(async () => {
      fireEvent.paste(textarea, {
        clipboardData: {
          items: [
            { type: 'text/plain', getAsFile: () => null },
          ],
        },
      });
    });

    expect(container.querySelector('[aria-label^="Remove"]')).toBeNull();
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

  describe('slash command completion', () => {
    it('shows dropdown when typing /', async () => {
      const { container } = await act(async () => renderWithRouter(<MessagePanel {...defaultProps} />));
      const view = within(container);

      const textarea = view.getByPlaceholderText('Send message to worker... (Ctrl+Enter to send)');
      await act(async () => {
        fireEvent.change(textarea, { target: { value: '/' } });
      });

      expect(view.getByRole('listbox')).toBeTruthy();
    });

    it('shows all commands when typing just /', async () => {
      const { container } = await act(async () => renderWithRouter(<MessagePanel {...defaultProps} />));
      const view = within(container);

      const textarea = view.getByPlaceholderText('Send message to worker... (Ctrl+Enter to send)');
      await act(async () => {
        fireEvent.change(textarea, { target: { value: '/' } });
      });

      const options = view.getAllByRole('option');
      expect(options.length).toBe(TEST_SKILLS.length);
    });

    it('shows filtered results when typing /re', async () => {
      const { container } = await act(async () => renderWithRouter(<MessagePanel {...defaultProps} />));
      const view = within(container);

      const textarea = view.getByPlaceholderText('Send message to worker... (Ctrl+Enter to send)');
      await act(async () => {
        fireEvent.change(textarea, { target: { value: '/re' } });
      });

      const options = view.getAllByRole('option');
      expect(options.length).toBe(1);
      expect(options[0].textContent).toContain('/review-loop');
    });

    it('does not show dropdown for non-/ prefix', async () => {
      const { container } = await act(async () => renderWithRouter(<MessagePanel {...defaultProps} />));
      const view = within(container);

      const textarea = view.getByPlaceholderText('Send message to worker... (Ctrl+Enter to send)');
      await act(async () => {
        fireEvent.change(textarea, { target: { value: 'hello /command' } });
      });

      expect(view.queryByRole('listbox')).toBeNull();
    });

    it('does not show dropdown when content has spaces', async () => {
      const { container } = await act(async () => renderWithRouter(<MessagePanel {...defaultProps} />));
      const view = within(container);

      const textarea = view.getByPlaceholderText('Send message to worker... (Ctrl+Enter to send)');
      await act(async () => {
        fireEvent.change(textarea, { target: { value: '/commit message' } });
      });

      expect(view.queryByRole('listbox')).toBeNull();
    });

    it('navigates items with arrow keys', async () => {
      const { container } = await act(async () => renderWithRouter(<MessagePanel {...defaultProps} />));
      const view = within(container);

      const textarea = view.getByPlaceholderText('Send message to worker... (Ctrl+Enter to send)');
      await act(async () => {
        fireEvent.change(textarea, { target: { value: '/' } });
      });

      // First item should be selected by default
      const options = view.getAllByRole('option');
      expect(options[0].getAttribute('aria-selected')).toBe('true');

      // Press ArrowDown to move to second item
      await act(async () => {
        fireEvent.keyDown(textarea, { key: 'ArrowDown' });
      });

      const updatedOptions = view.getAllByRole('option');
      expect(updatedOptions[0].getAttribute('aria-selected')).toBe('false');
      expect(updatedOptions[1].getAttribute('aria-selected')).toBe('true');
    });

    it('selects command with Enter', async () => {
      const { container } = await act(async () => renderWithRouter(<MessagePanel {...defaultProps} />));
      const view = within(container);

      const textarea = view.getByPlaceholderText('Send message to worker... (Ctrl+Enter to send)') as HTMLTextAreaElement;
      await act(async () => {
        fireEvent.change(textarea, { target: { value: '/co' } });
      });

      // /commit and /code-review match; first is /code-review or /commit depending on order
      // The filtered list is prefix-matched: /co matches /commit and /code-review
      await act(async () => {
        fireEvent.keyDown(textarea, { key: 'Enter' });
      });

      // First matching command should be selected
      expect(textarea.value).toBe('/commit ');
      // Dropdown should be closed (content now has a space)
      expect(view.queryByRole('listbox')).toBeNull();
    });

    it('selects command with Tab', async () => {
      const { container } = await act(async () => renderWithRouter(<MessagePanel {...defaultProps} />));
      const view = within(container);

      const textarea = view.getByPlaceholderText('Send message to worker... (Ctrl+Enter to send)') as HTMLTextAreaElement;
      await act(async () => {
        fireEvent.change(textarea, { target: { value: '/sc' } });
      });

      await act(async () => {
        fireEvent.keyDown(textarea, { key: 'Tab' });
      });

      expect(textarea.value).toBe('/schedule ');
    });

    it('closes dropdown with Escape', async () => {
      const { container } = await act(async () => renderWithRouter(<MessagePanel {...defaultProps} />));
      const view = within(container);

      const textarea = view.getByPlaceholderText('Send message to worker... (Ctrl+Enter to send)');
      await act(async () => {
        fireEvent.change(textarea, { target: { value: '/' } });
      });

      expect(view.getByRole('listbox')).toBeTruthy();

      await act(async () => {
        fireEvent.keyDown(textarea, { key: 'Escape' });
      });

      expect(view.queryByRole('listbox')).toBeNull();
      // Escape should NOT send PTY input when dropdown was visible
      expect(mockSendInput).not.toHaveBeenCalled();
    });

    it('selects command on click', async () => {
      const { container } = await act(async () => renderWithRouter(<MessagePanel {...defaultProps} />));
      const view = within(container);

      const textarea = view.getByPlaceholderText('Send message to worker... (Ctrl+Enter to send)') as HTMLTextAreaElement;
      await act(async () => {
        fireEvent.change(textarea, { target: { value: '/' } });
      });

      const options = view.getAllByRole('option');
      // Click the second command
      await act(async () => {
        fireEvent.mouseDown(options[1]);
      });

      expect(textarea.value).toBe(TEST_SKILLS[1].name + ' ');
    });

    it('does not show dropdown when no commands match filter', async () => {
      const { container } = await act(async () => renderWithRouter(<MessagePanel {...defaultProps} />));
      const view = within(container);

      const textarea = view.getByPlaceholderText('Send message to worker... (Ctrl+Enter to send)');
      await act(async () => {
        fireEvent.change(textarea, { target: { value: '/xyz' } });
      });

      expect(view.queryByRole('listbox')).toBeNull();
    });

    it('shows no dropdown when skills API returns empty', async () => {
      mockFetchSkills.mockImplementation(() => Promise.resolve({ skills: [] }));

      const { container } = await act(async () => renderWithRouter(<MessagePanel {...defaultProps} />));
      const view = within(container);

      const textarea = view.getByPlaceholderText('Send message to worker... (Ctrl+Enter to send)');
      await act(async () => {
        fireEvent.change(textarea, { target: { value: '/' } });
      });

      expect(view.queryByRole('listbox')).toBeNull();
    });
  });

  describe('message templates', () => {
    it('renders the template button with correct aria-label', async () => {
      const { container } = await act(async () => renderWithRouter(<MessagePanel {...defaultProps} />));
      const view = within(container);

      expect(view.getByLabelText('Message templates')).toBeTruthy();
    });

    it('toggles template selector when template button is clicked', async () => {
      const { container } = await act(async () => renderWithRouter(<MessagePanel {...defaultProps} />));
      const view = within(container);

      const templateButton = view.getByLabelText('Message templates');

      // Click to open
      await act(async () => {
        fireEvent.click(templateButton);
      });

      expect(view.getByPlaceholderText('Search templates...')).toBeTruthy();

      // Click again to close
      await act(async () => {
        fireEvent.click(templateButton);
      });

      expect(view.queryByPlaceholderText('Search templates...')).toBeNull();
    });

    it('Ctrl+/ toggles template selector', async () => {
      const { container } = await act(async () => renderWithRouter(<MessagePanel {...defaultProps} />));
      const view = within(container);

      const textarea = view.getByPlaceholderText('Send message to worker... (Ctrl+Enter to send)');

      // Press Ctrl+/ to open
      await act(async () => {
        fireEvent.keyDown(textarea, { key: '/', ctrlKey: true });
      });

      expect(view.getByPlaceholderText('Search templates...')).toBeTruthy();

      // Press Ctrl+/ again to close
      await act(async () => {
        fireEvent.keyDown(textarea, { key: '/', ctrlKey: true });
      });

      expect(view.queryByPlaceholderText('Search templates...')).toBeNull();
    });

    it('shows save-as-template button when content exists', async () => {
      const { container } = await act(async () => renderWithRouter(<MessagePanel {...defaultProps} />));
      const view = within(container);

      const textarea = view.getByPlaceholderText('Send message to worker... (Ctrl+Enter to send)');
      await act(async () => {
        fireEvent.change(textarea, { target: { value: 'some message content' } });
      });

      expect(view.getByLabelText('Save as template')).toBeTruthy();
    });

    it('hides save-as-template button when content is empty', async () => {
      const { container } = await act(async () => renderWithRouter(<MessagePanel {...defaultProps} />));
      const view = within(container);

      expect(view.queryByLabelText('Save as template')).toBeNull();
    });
  });

});
