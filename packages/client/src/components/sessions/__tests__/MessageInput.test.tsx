import { describe, it, expect, mock, afterEach } from 'bun:test';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MessageInput, canSend, validateFiles } from '../MessageInput';
import { MAX_MESSAGE_FILES, MAX_TOTAL_FILE_SIZE } from '@agent-console/shared';

describe('MessageInput', () => {
  afterEach(() => {
    cleanup();
  });

  describe('basic send functionality', () => {
    it('should call onSend with text content when send button is clicked', async () => {
      const user = userEvent.setup();
      const onSend = mock(() => Promise.resolve());

      render(<MessageInput onSend={onSend} />);

      const textarea = screen.getByRole('textbox');
      await user.type(textarea, 'Hello, world!');

      const sendButton = screen.getByRole('button', { name: 'Send' });
      await user.click(sendButton);

      await waitFor(() => {
        expect(onSend).toHaveBeenCalledTimes(1);
      });
      expect(onSend).toHaveBeenCalledWith('Hello, world!', undefined);
    });

    it('should reset form after successful send', async () => {
      const user = userEvent.setup();
      const onSend = mock(() => Promise.resolve());

      render(<MessageInput onSend={onSend} />);

      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
      await user.type(textarea, 'Test message');

      const sendButton = screen.getByRole('button', { name: 'Send' });
      await user.click(sendButton);

      await waitFor(() => {
        expect(textarea.value).toBe('');
      });
    });

    it('should not call onSend when textarea is empty', async () => {
      const user = userEvent.setup();
      const onSend = mock(() => Promise.resolve());

      render(<MessageInput onSend={onSend} />);

      const sendButton = screen.getByRole('button', { name: 'Send' });
      await user.click(sendButton);

      expect(onSend).not.toHaveBeenCalled();
    });

    it('should not call onSend when only whitespace is entered', async () => {
      const user = userEvent.setup();
      const onSend = mock(() => Promise.resolve());

      render(<MessageInput onSend={onSend} />);

      const textarea = screen.getByRole('textbox');
      await user.type(textarea, '   ');

      const sendButton = screen.getByRole('button', { name: 'Send' });
      await user.click(sendButton);

      expect(onSend).not.toHaveBeenCalled();
    });
  });

  describe('stop button visibility', () => {
    it('should show stop button when sending=true and onStop is provided', () => {
      const onSend = mock(() => Promise.resolve());
      const onStop = mock(() => {});

      render(<MessageInput onSend={onSend} onStop={onStop} sending={true} />);

      expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    });

    it('should show send button when sending=false', () => {
      const onSend = mock(() => Promise.resolve());
      const onStop = mock(() => {});

      render(<MessageInput onSend={onSend} onStop={onStop} sending={false} />);

      expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    });

    it('should show send button when onStop is undefined even if sending=true', () => {
      const onSend = mock(() => Promise.resolve());

      render(<MessageInput onSend={onSend} sending={true} />);

      expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    });

    it('should call onStop when stop button is clicked', async () => {
      const user = userEvent.setup();
      const onSend = mock(() => Promise.resolve());
      const onStop = mock(() => {});

      render(<MessageInput onSend={onSend} onStop={onStop} sending={true} />);

      const stopButton = screen.getByRole('button', { name: 'Stop' });
      await user.click(stopButton);

      expect(onStop).toHaveBeenCalledTimes(1);
    });
  });

  describe('disabled state', () => {
    it('should disable textarea when disabled=true', () => {
      const onSend = mock(() => Promise.resolve());

      render(<MessageInput onSend={onSend} disabled={true} />);

      const textarea = screen.getByRole('textbox');
      expect((textarea as HTMLTextAreaElement).disabled).toBe(true);
    });

    it('should disable send button when disabled=true', () => {
      const onSend = mock(() => Promise.resolve());

      render(<MessageInput onSend={onSend} disabled={true} />);

      const sendButton = screen.getByRole('button', { name: 'Send' });
      expect((sendButton as HTMLButtonElement).disabled).toBe(true);
    });

    it('should not call onSend when disabled even if text is entered', async () => {
      const onSend = mock(() => Promise.resolve());

      const { rerender } = render(<MessageInput onSend={onSend} disabled={false} />);

      const textarea = screen.getByRole('textbox');
      await act(async () => {
        fireEvent.change(textarea, { target: { value: 'Test message' } });
      });

      // Re-render with disabled=true
      rerender(<MessageInput onSend={onSend} disabled={true} />);

      const sendButton = screen.getByRole('button', { name: 'Send' });
      await act(async () => {
        fireEvent.click(sendButton);
      });

      expect(onSend).not.toHaveBeenCalled();
    });
  });

  describe('keyboard shortcuts', () => {
    it('should trigger send on Ctrl+Enter', async () => {
      const user = userEvent.setup();
      const onSend = mock(() => Promise.resolve());

      render(<MessageInput onSend={onSend} />);

      const textarea = screen.getByRole('textbox');
      await user.type(textarea, 'Test message');
      await user.keyboard('{Control>}{Enter}{/Control}');

      await waitFor(() => {
        expect(onSend).toHaveBeenCalledTimes(1);
      });
      expect(onSend).toHaveBeenCalledWith('Test message', undefined);
    });

    it('should trigger send on Meta+Enter (Mac)', async () => {
      const user = userEvent.setup();
      const onSend = mock(() => Promise.resolve());

      render(<MessageInput onSend={onSend} />);

      const textarea = screen.getByRole('textbox');
      await user.type(textarea, 'Test message');
      await user.keyboard('{Meta>}{Enter}{/Meta}');

      await waitFor(() => {
        expect(onSend).toHaveBeenCalledTimes(1);
      });
    });

    it('should not trigger send on plain Enter', async () => {
      const user = userEvent.setup();
      const onSend = mock(() => Promise.resolve());

      render(<MessageInput onSend={onSend} />);

      const textarea = screen.getByRole('textbox');
      await user.type(textarea, 'Test message{Enter}');

      expect(onSend).not.toHaveBeenCalled();
    });
  });

  describe('placeholder', () => {
    it('should show default placeholder when not provided', () => {
      const onSend = mock(() => Promise.resolve());

      render(<MessageInput onSend={onSend} />);

      const textarea = screen.getByPlaceholderText(/Send message/);
      expect(textarea).toBeTruthy();
    });

    it('should show custom placeholder when provided', () => {
      const onSend = mock(() => Promise.resolve());

      render(<MessageInput onSend={onSend} placeholder="Custom placeholder" />);

      const textarea = screen.getByPlaceholderText('Custom placeholder');
      expect(textarea).toBeTruthy();
    });
  });

  describe('error handling', () => {
    it('should not reset form when onSend throws', async () => {
      const user = userEvent.setup();
      const onSend = mock(() => Promise.reject(new Error('Send failed')));

      render(<MessageInput onSend={onSend} />);

      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
      await user.type(textarea, 'Test message');

      const sendButton = screen.getByRole('button', { name: 'Send' });
      await user.click(sendButton);

      await waitFor(() => {
        expect(onSend).toHaveBeenCalledTimes(1);
      });

      // Form should not be reset on error
      expect(textarea.value).toBe('Test message');
    });
  });
});

describe('canSend utility', () => {
  it('should return false when targetWorkerId is empty', () => {
    expect(canSend('', 'some content', false, 0)).toBe(false);
  });

  it('should return false when sending is true', () => {
    expect(canSend('worker-1', 'some content', true, 0)).toBe(false);
  });

  it('should return false when content is empty and no files', () => {
    expect(canSend('worker-1', '', false, 0)).toBe(false);
    expect(canSend('worker-1', '   ', false, 0)).toBe(false);
  });

  it('should return true when content has text', () => {
    expect(canSend('worker-1', 'some content', false, 0)).toBe(true);
  });

  it('should return true when files are present even with empty content', () => {
    expect(canSend('worker-1', '', false, 1)).toBe(true);
  });
});

describe('validateFiles utility', () => {
  it('should return null for valid files', () => {
    expect(validateFiles({ length: 1, totalSize: 1024 })).toBeNull();
  });

  it('should return error when too many files', () => {
    const result = validateFiles({ length: MAX_MESSAGE_FILES + 1, totalSize: 1024 });
    expect(result).not.toBeNull();
    expect(result![0]).toBe('Too Many Files');
  });

  it('should return error when total size exceeds limit', () => {
    const result = validateFiles({ length: 1, totalSize: MAX_TOTAL_FILE_SIZE + 1 });
    expect(result).not.toBeNull();
    expect(result![0]).toBe('File Size Limit');
  });

  it('should allow max files and max size', () => {
    expect(validateFiles({ length: MAX_MESSAGE_FILES, totalSize: MAX_TOTAL_FILE_SIZE })).toBeNull();
  });
});
