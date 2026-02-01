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

    expect(mockSendWorkerMessage).toHaveBeenCalledWith('session-1', 'agent-1', 'hello');
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

    expect(mockSendWorkerMessage).toHaveBeenCalledWith('session-1', 'agent-1', 'hello');
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
