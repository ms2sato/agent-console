import { describe, it, expect, afterEach } from 'bun:test';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SessionSettingsMenu } from '../SessionSettingsMenu';

afterEach(() => {
  cleanup();
});

describe('SessionSettingsMenu', () => {
  it('should have aria-label="Session settings" on the trigger button', () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <SessionSettingsMenu
          sessionId="test-session"
          worktreePath="/path/to/worktree"
          isMainWorktree={false}
          onMenuAction={() => {}}
        />
      </QueryClientProvider>
    );

    const button = screen.getByRole('button', { name: 'Session settings' });
    expect(button).toBeTruthy();
  });
});
