/**
 * Integration test: Paste Focus Isolation (#523)
 *
 * Verifies that paste events are correctly routed based on component focus.
 * Terminal paste tests require xterm.js and are covered by manual verification.
 */
import { describe, it, expect, mock, afterEach, beforeEach } from 'bun:test';
import { fireEvent, cleanup, act, within } from '@testing-library/react';

// Mock dependencies required by MessagePanel
const mockSendWorkerMessage = mock(() =>
  Promise.resolve({
    message: {
      id: 'msg-1',
      sessionId: 'session-1',
      fromWorkerId: 'user',
      fromWorkerName: 'User',
      toWorkerId: 'worker-1',
      toWorkerName: 'Worker 1',
      content: '',
      timestamp: new Date().toISOString(),
    },
  })
);
mock.module('@agent-console/client/src/lib/api', () => ({
  sendWorkerMessage: mockSendWorkerMessage,
}));
mock.module('@agent-console/client/src/lib/worker-websocket', () => ({
  sendInput: mock(() => true),
}));

import { MessagePanel } from '@agent-console/client/src/components/sessions/MessagePanel';
import { renderWithRouter } from '@agent-console/client/src/test/renderWithRouter';
import { _getDraftsMap } from '@agent-console/client/src/hooks/useDraftMessage';

const defaultProps = {
  sessionId: 'session-1',
  targetWorkerId: 'worker-1',
  newMessage: null,
};

describe('Paste Focus Isolation (#523)', () => {
  beforeEach(() => {
    _getDraftsMap().clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('image paste on focused MessagePanel textarea adds files without Terminal involvement', async () => {
    const { container } = await act(async () =>
      renderWithRouter(<MessagePanel {...defaultProps} />)
    );
    const view = within(container);
    const textarea = view.getByPlaceholderText(
      'Send message to worker... (Ctrl+Enter to send)'
    );

    // Focus the textarea (simulating MessagePanel having focus)
    textarea.focus();

    // Simulate paste with image data
    const mockFile = new File(['image-data'], 'screenshot.png', { type: 'image/png' });
    await act(async () => {
      fireEvent.paste(textarea, {
        clipboardData: {
          items: [{ type: 'image/png', getAsFile: () => mockFile }],
        },
      });
    });

    // File should appear as a chip in MessagePanel
    expect(container.querySelector('[aria-label="Remove screenshot.png"]')).toBeTruthy();
  });

  it('text-only paste on focused MessagePanel does not add files', async () => {
    const { container } = await act(async () =>
      renderWithRouter(<MessagePanel {...defaultProps} />)
    );
    const view = within(container);
    const textarea = view.getByPlaceholderText(
      'Send message to worker... (Ctrl+Enter to send)'
    );

    textarea.focus();

    await act(async () => {
      fireEvent.paste(textarea, {
        clipboardData: {
          items: [{ type: 'text/plain', getAsFile: () => null }],
        },
      });
    });

    // No file chips should appear
    expect(container.querySelector('[aria-label^="Remove"]')).toBeNull();
  });
});
