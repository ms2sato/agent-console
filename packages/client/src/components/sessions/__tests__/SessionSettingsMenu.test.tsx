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
});
