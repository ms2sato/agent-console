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
  // prototype-level descriptor happy-dom installed. Reflect.deleteProperty is
  // safe because installClipboardMock defined the property as configurable.
  Reflect.deleteProperty(navigator, 'clipboard');
  if (originalClipboardDescriptor && !('clipboard' in navigator)) {
    Object.defineProperty(
      Object.getPrototypeOf(navigator),
      'clipboard',
      originalClipboardDescriptor,
    );
  }
}

// happy-dom does not implement `window.isSecureContext` (it is
// `undefined`, i.e. falsy) regardless of the test host. Real browsers treat
// `http://localhost` as a secure context, so we stub `true` here to match
// real-browser behavior for the happy-path tests below, mirroring the
// EmbeddedAgentWorkerView copy-markdown test pattern (#1159).
const originalIsSecureContextDescriptor = Object.getOwnPropertyDescriptor(window, 'isSecureContext');

function installSecureContext() {
  Object.defineProperty(window, 'isSecureContext', { value: true, writable: true, configurable: true });
}

function restoreSecureContext() {
  if (originalIsSecureContextDescriptor) {
    Object.defineProperty(window, 'isSecureContext', originalIsSecureContextDescriptor);
  } else {
    Reflect.deleteProperty(window, 'isSecureContext');
  }
}

beforeEach(() => {
  resetServerInfo();
  installClipboardMock();
  installSecureContext();
});

afterEach(() => {
  cleanup();
  restoreClipboard();
  restoreSecureContext();
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

  it('falls back to document.execCommand("copy") and shows "Copied!" when navigator.clipboard is unavailable (non-secure context, #1345)', async () => {
    setServerPort(3457);

    // navigator.clipboard is only defined in a secure context (HTTPS or
    // localhost/127.0.0.1). Dev-server access over plain-HTTP LAN
    // (e.g. http://192.168.1.12:5173/) leaves it undefined, so the primary
    // path must fall back to the legacy execCommand('copy') technique
    // instead of silently failing (#1345).
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, 'isSecureContext', { value: false, writable: true, configurable: true });

    const execCommandMock = mock(() => true);
    // happy-dom does not implement execCommand, so assign it directly
    // rather than spyOn-wrapping a nonexistent method.
    Object.defineProperty(document, 'execCommand', {
      value: execCommandMock,
      configurable: true,
    });

    try {
      render(<McpInstallSection />);
      const copyButton = screen.getByRole('button', { name: 'Copy install command' });

      await act(async () => {
        fireEvent.click(copyButton);
        await Promise.resolve();
      });

      expect(execCommandMock).toHaveBeenCalledWith('copy');
      expect(writeTextMock).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Copy install command' }).textContent).toBe('Copied!');
    } finally {
      Reflect.deleteProperty(document, 'execCommand');
    }
  });
});
