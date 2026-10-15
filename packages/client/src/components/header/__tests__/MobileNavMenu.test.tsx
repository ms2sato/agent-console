import { describe, it, expect, mock, afterEach } from 'bun:test';
import { screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { renderWithRouter } from '../../../test/renderWithRouter';
import { MobileNavMenu } from '../MobileNavMenu';
import { setCurrentUser, _reset as resetAuth } from '../../../lib/auth';
import { makeTodo, jsonResponse } from '../../../test/todo-fixtures';

describe('MobileNavMenu', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    resetAuth();
  });

  describe('Rendering', () => {
    it('should render navigation links when open', async () => {
      await renderWithRouter(<MobileNavMenu open={true} onClose={() => {}} />);
      expect(screen.getByText('Jobs')).toBeTruthy();
      expect(screen.getByText('Agents')).toBeTruthy();
      const artifacts = screen.getByText('Artifacts');
      expect(artifacts).toBeTruthy();
      expect(artifacts.closest('a')!.getAttribute('href')).toBe('/artifacts');
      expect(screen.getByText('Repositories')).toBeTruthy();
      const settings = screen.getByText('Settings');
      expect(settings).toBeTruthy();
      expect(settings.closest('a')!.getAttribute('href')).toBe('/settings');
    });

    it('should not render when closed', async () => {
      await renderWithRouter(<MobileNavMenu open={false} onClose={() => {}} />);
      expect(screen.queryByText('Jobs')).toBeNull();
      expect(screen.queryByText('Agents')).toBeNull();
      expect(screen.queryByText('Artifacts')).toBeNull();
      expect(screen.queryByText('Repositories')).toBeNull();
      expect(screen.queryByText('Settings')).toBeNull();
    });

    it('should mark Artifacts active on any /artifacts sub-path', async () => {
      await renderWithRouter(<MobileNavMenu open={true} onClose={() => {}} />, '/artifacts/artifact-1');
      expect(screen.getByText('Artifacts').className).toContain('bg-white/10');
    });

    it('should mark Artifacts active on the exact /artifacts path', async () => {
      await renderWithRouter(<MobileNavMenu open={true} onClose={() => {}} />, '/artifacts');
      expect(screen.getByText('Artifacts').className).toContain('bg-white/10');
    });

    it('should mark Settings active only on the exact /settings path, not /settings/repositories', async () => {
      await renderWithRouter(<MobileNavMenu open={true} onClose={() => {}} />, '/settings/repositories');
      // On /settings/repositories, Repositories is active and Settings is not
      // (guards against startsWith double-highlighting both).
      expect(screen.getByText('Repositories').className).toContain('bg-white/10');
      expect(screen.getByText('Settings').className).not.toContain('bg-white/10');

      cleanup();

      await renderWithRouter(<MobileNavMenu open={true} onClose={() => {}} />, '/settings');
      expect(screen.getByText('Settings').className).toContain('bg-white/10');
    });

    it('should have Main navigation aria-label', async () => {
      await renderWithRouter(<MobileNavMenu open={true} onClose={() => {}} />);
      const nav = screen.getByRole('navigation');
      expect(nav.getAttribute('aria-label')).toBe('Main navigation');
    });
  });

  describe('To-do link', () => {
    it('links to /todos and is active on /todos', async () => {
      await renderWithRouter(<MobileNavMenu open={true} onClose={() => {}} />, '/todos');
      const link = screen.getByText('To-do').closest('a')!;
      expect(link.getAttribute('href')).toBe('/todos');
      expect(link.className).toContain('bg-white/10');
    });

    it('shows the count of open items assigned to the current user', async () => {
      setCurrentUser({ id: 'user-me', username: 'me', homeDir: '/home/me' });
      globalThis.fetch = Object.assign(
        mock(async () =>
          jsonResponse({
            todos: [
              makeTodo({ id: 'a', assigneeUserId: 'user-me' }),
              makeTodo({ id: 'b', assigneeUserId: 'user-me', status: 'dismissed' }),
            ],
          }),
        ),
        { preconnect: () => {} },
      ) as typeof fetch;

      await renderWithRouter(<MobileNavMenu open={true} onClose={() => {}} />);

      await waitFor(() => {
        expect(screen.getByLabelText('1 open to-do items assigned to you')).toBeTruthy();
      });
    });

    it('shows no badge without a current user', async () => {
      await renderWithRouter(<MobileNavMenu open={true} onClose={() => {}} />);
      expect(screen.queryByLabelText(/open to-do items assigned to you/)).toBeNull();
    });
  });

  describe('Interactions', () => {
    it('should call onClose when Escape key is pressed', async () => {
      const onClose = mock(() => {});
      await renderWithRouter(<MobileNavMenu open={true} onClose={onClose} />);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('should not respond to Escape when closed', async () => {
      const onClose = mock(() => {});
      await renderWithRouter(<MobileNavMenu open={false} onClose={onClose} />);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(onClose).not.toHaveBeenCalled();
    });

    it('should call onClose when backdrop is clicked', async () => {
      const onClose = mock(() => {});
      await renderWithRouter(<MobileNavMenu open={true} onClose={onClose} />);
      // Backdrop is the fixed-inset div with aria-hidden="true"
      const backdrop = document.querySelector('[aria-hidden="true"]');
      expect(backdrop).toBeTruthy();
      fireEvent.click(backdrop!);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('should call onClose when a navigation link is clicked', async () => {
      const onClose = mock(() => {});
      await renderWithRouter(<MobileNavMenu open={true} onClose={onClose} />);
      const jobsLink = screen.getByText('Jobs');
      fireEvent.click(jobsLink);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});
