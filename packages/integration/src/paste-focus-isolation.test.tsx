/**
 * Integration test: Paste Focus Isolation (#523)
 *
 * Verifies that paste events are correctly routed based on component focus.
 * Terminal paste tests require xterm.js and are covered by manual verification.
 */
import { describe, it, expect, mock, afterEach, beforeEach } from 'bun:test';
import { fireEvent, cleanup, act, within } from '@testing-library/react';
import { MessagePanel } from '@agent-console/client/src/components/sessions/MessagePanel';
import { renderWithRouter } from '@agent-console/client/src/test/renderWithRouter';
import { _getDraftsMap } from '@agent-console/client/src/hooks/useDraftMessage';

// MessagePanel resolves its send action via an injected `onSend` prop, not
// via a module-level import of `lib/api` / `lib/worker-websocket` -- the
// prior `mock.module()` of those two modules was a leftover from before
// that DI seam existed and mocked exports MessagePanel no longer reads.
// Neither test below triggers a send, but `onSend` is a required prop.
// Using the real DI seam (Pattern 1) instead of `mock.module()` avoids
// process-globally poisoning sibling integration tests that import
// `lib/api` / `lib/worker-websocket` for real in the same bun:test
// process (e.g. system-api-boundary.test.ts) -- the live #1225-class
// poisoner this file used to be (`.claude/rules/testing.md` Anti-Pattern #2).
const mockOnSend = mock(() => Promise.resolve());

const defaultProps = {
  sessionId: 'session-1',
  targetWorkerId: 'worker-1',
  newMessage: null,
  onSend: mockOnSend,
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
