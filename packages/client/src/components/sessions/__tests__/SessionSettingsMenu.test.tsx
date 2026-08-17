import { describe, it, expect, mock, afterEach, afterAll } from 'bun:test';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SessionSettingsMenu } from '../SessionSettingsMenu';

// SessionSettingsMenu enables the `fetchSessionPrLink` query as soon as the
// menu opens. Without a fetch-level stub, every test that opens the menu
// fires a real, unmocked network request that resolves/rejects after the
// test's assertions already ran, making the suite non-deterministic.
const originalFetch = globalThis.fetch;
const mockFetch = mock(() =>
  Promise.resolve(
    new Response(JSON.stringify({ prUrl: null, branchName: 'test-branch', orgRepo: null }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  )
);
globalThis.fetch = Object.assign(mockFetch, { preconnect: () => {} });

afterAll(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  cleanup();
  mockFetch.mockClear();
});

// Preserve the original clipboard descriptor so we can restore it per-test.
// happy-dom provides a real clipboard implementation; we swap it out for a
// jest-mock so we can assert on `writeText` calls without touching the OS
// (mirrors the McpInstallSection / EmbeddedAgentWorkerView copy-button
// mock patterns, #1345).
const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(navigator),
  'clipboard',
);

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
  Reflect.deleteProperty(navigator, 'clipboard');
  if (originalClipboardDescriptor && !('clipboard' in navigator)) {
    Object.defineProperty(Object.getPrototypeOf(navigator), 'clipboard', originalClipboardDescriptor);
  }
}

// happy-dom does not implement `window.isSecureContext` (it is
// `undefined`, i.e. falsy). Real browsers treat `http://localhost` as a
// secure context, so we stub `true` here for the happy-path test below.
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

function renderMenu(props: Partial<React.ComponentProps<typeof SessionSettingsMenu>> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <SessionSettingsMenu
        sessionId="test-session"
        worktreePath="/path/to/worktree"
        isMainWorktree={false}
        onMenuAction={() => {}}
        {...props}
      />
    </QueryClientProvider>
  );
}

describe('SessionSettingsMenu', () => {
  it('should have aria-label="Session settings" on the trigger button', () => {
    renderMenu();

    const button = screen.getByRole('button', { name: 'Session settings' });
    expect(button).toBeTruthy();
  });

  describe('pauseDisabled (Issue #1247)', () => {
    it('disables the Pause menu entry and does not fire onMenuAction when clicked', async () => {
      const onMenuAction = mock(() => {});
      renderMenu({ pauseDisabled: true, onMenuAction });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Session settings' }));
      });

      const pauseButton = screen.getByRole('button', { name: /Pause/ });
      expect((pauseButton as HTMLButtonElement).disabled).toBe(true);

      fireEvent.click(pauseButton);
      expect(onMenuAction).not.toHaveBeenCalled();
    });

    it('leaves the Pause menu entry enabled by default', async () => {
      const onMenuAction = mock(() => {});
      renderMenu({ onMenuAction });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Session settings' }));
      });

      const pauseButton = screen.getByRole('button', { name: /Pause/ });
      expect((pauseButton as HTMLButtonElement).disabled).toBe(false);

      fireEvent.click(pauseButton);
      expect(onMenuAction).toHaveBeenCalledWith('pause');
    });
  });

  describe('Copy Path (#1345)', () => {
    afterEach(() => {
      restoreClipboard();
      restoreSecureContext();
    });

    it('copies the worktree path to the clipboard (secure context)', async () => {
      installClipboardMock();
      installSecureContext();

      renderMenu({ worktreePath: '/path/to/worktree' });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Session settings' }));
      });

      const copyPathButton = screen.getByRole('button', { name: 'Copy Path' });
      await act(async () => {
        fireEvent.click(copyPathButton);
        await Promise.resolve();
      });

      expect(writeTextMock).toHaveBeenCalledTimes(1);
      expect(writeTextMock.mock.calls[0]?.[0]).toBe('/path/to/worktree');
      // NOTE: handleCopyPath unconditionally closes the menu
      // (setIsMenuOpen(false)) in the same synchronous batch as
      // setCopySuccess(true), so the "Copied!" label is never actually
      // rendered to the user -- this is pre-existing behavior, unrelated to
      // the clipboard-guard change (#1345), not asserted here.
      expect(screen.queryByRole('button', { name: 'Session settings' })).toBeTruthy();
    });

    it('falls back to document.execCommand("copy") when navigator.clipboard is unavailable (non-secure context)', async () => {
      // navigator.clipboard is only defined in a secure context (HTTPS or
      // localhost/127.0.0.1). Dev-server access over plain-HTTP LAN
      // (e.g. http://192.168.1.12:5173/) leaves it undefined, so the
      // primary path must fall back to the legacy execCommand('copy')
      // technique instead of silently failing (#1345).
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
        renderMenu({ worktreePath: '/path/to/worktree' });

        await act(async () => {
          fireEvent.click(screen.getByRole('button', { name: 'Session settings' }));
        });

        const copyPathButton = screen.getByRole('button', { name: 'Copy Path' });
        await act(async () => {
          fireEvent.click(copyPathButton);
          await Promise.resolve();
        });

        expect(execCommandMock).toHaveBeenCalledWith('copy');
      } finally {
        Reflect.deleteProperty(document, 'execCommand');
      }
    });
  });
});
