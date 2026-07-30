import { describe, it, expect, mock, afterEach } from 'bun:test';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SessionSettingsMenu } from '../SessionSettingsMenu';

afterEach(() => {
  cleanup();
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
