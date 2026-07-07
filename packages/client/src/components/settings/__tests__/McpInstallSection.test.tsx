import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import { McpInstallSection } from '../McpInstallSection';
import { setServerPort, _reset as resetServerInfo } from '../../../lib/server-info';

// Preserve the original clipboard descriptor so we can restore it per-test.
// happy-dom provides a real clipboard implementation; we swap it out for a
// jest-mock so we can assert on `writeText` calls without touching the OS.
const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(navigator),
  'clipboard',
);

// Fresh writeText mock per test so counts / args do not bleed across tests.
let writeTextMock: ReturnType<typeof mock>;

function installClipboardMock() {
  writeTextMock = mock(() => Promise.resolve());
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: writeTextMock },
    writable: true,
    configurable: true,
  });
}

function restoreClipboard() {
  // Remove the per-instance override so navigator.clipboard falls back to the
  // prototype-level descriptor happy-dom installed. Deletion is safe because
  // installClipboardMock defined the property as configurable.
  delete (navigator as unknown as { clipboard?: unknown }).clipboard;
  if (originalClipboardDescriptor && !('clipboard' in navigator)) {
    Object.defineProperty(
      Object.getPrototypeOf(navigator),
      'clipboard',
      originalClipboardDescriptor,
    );
  }
}

beforeEach(() => {
  resetServerInfo();
  installClipboardMock();
});

afterEach(() => {
  cleanup();
  restoreClipboard();
});

describe('McpInstallSection', () => {
  it('renders nothing when serverPort has not been set', () => {
    const { container } = render(<McpInstallSection />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the section heading and the install command with the server port', () => {
    setServerPort(3457);
    render(<McpInstallSection />);

    expect(screen.getByText('Install MCP server in Claude Code')).toBeTruthy();

    // The command block should contain the /mcp URL with the configured port.
    // In the happy-dom test environment window.location.port is empty and the
    // origin is used as-is, so the exact URL reflects the current test host.
    const codeBlock = screen.getByText(/^claude mcp add --transport http agent-console /);
    expect(codeBlock.textContent).toContain('/mcp');
    expect(codeBlock.tagName.toLowerCase()).toBe('code');
  });

  it('copies the command to the clipboard when the Copy button is clicked', async () => {
    setServerPort(3457);
    render(<McpInstallSection />);

    const copyButton = screen.getByRole('button', { name: 'Copy install command' });
    expect(copyButton.textContent).toBe('Copy');

    // We use `fireEvent` rather than `userEvent` because `userEvent.setup()`
    // installs its own clipboard stub via a `navigator.clipboard` getter, which
    // shadows the mock we install above. `fireEvent.click` bypasses that setup
    // and dispatches the click directly.
    await act(async () => {
      fireEvent.click(copyButton);
      // Yield so the async click handler's `await navigator.clipboard.writeText`
      // microtask resolves before we assert.
      await Promise.resolve();
    });

    expect(writeTextMock).toHaveBeenCalledTimes(1);
    const arg = writeTextMock.mock.calls[0][0] as string;
    expect(arg).toMatch(/^claude mcp add --transport http agent-console .+\/mcp$/);
  });

  it('flips button label to "Copied!" after a successful copy', async () => {
    setServerPort(3457);
    render(<McpInstallSection />);

    const copyButton = screen.getByRole('button', { name: 'Copy install command' });

    await act(async () => {
      fireEvent.click(copyButton);
      await Promise.resolve();
    });

    // After the click resolves, the button label should reflect the "copied" state.
    expect(screen.getByRole('button', { name: 'Copy install command' }).textContent).toBe('Copied!');
  });
});
