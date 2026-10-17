import { describe, it, expect, mock, afterEach, beforeEach } from 'bun:test';
import { screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { renderWithRouter } from '../../../test/renderWithRouter';
import { MobileNavMenu } from '../MobileNavMenu';
import { setCurrentUser, _reset as resetAuth } from '../../../lib/auth';
import { makeTodo, jsonResponse, fetchUrl } from '../../../test/todo-fixtures';
import { completeWireBody } from '../../../test/wire-fixtures';
import { setAuthMode } from '../../../lib/auth';
import { installMockWebSocket } from '../../../test/mock-websocket';
import { _reset as resetWebSocket } from '../../../lib/app-websocket';
import { NAV_ITEMS, navItemsForAuthMode } from '../nav-items';

describe('MobileNavMenu', () => {
  const originalFetch = globalThis.fetch;

  let restoreWebSocket: () => void;

  beforeEach(() => {
    restoreWebSocket = installMockWebSocket();
    resetWebSocket();
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    restoreWebSocket();
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

  describe('Todo link', () => {
    it('links to /todos and is active on /todos', async () => {
      await renderWithRouter(<MobileNavMenu open={true} onClose={() => {}} />, '/todos');
      const link = screen.getByText('Todo').closest('a')!;
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
        expect(
          screen.getByRole('link', { name: /1 open Todo items assigned to you/ }).getAttribute('href'),
        ).toBe('/todos');
      });
    });

    it('shows no badge without a current user', async () => {
      await renderWithRouter(<MobileNavMenu open={true} onClose={() => {}} />);
      expect(screen.queryByText(/open Todo items assigned to you/)).toBeNull();
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

  describe('Shared item list', () => {
    interface Backend {
      reviewQueue: unknown;
      validation: unknown;
      logoutRequests: number;
      validationRequests: number;
    }

    function installBackend(overrides: Partial<Backend> = {}): Backend {
      const backend: Backend = {
        reviewQueue: [],
        validation: { hasIssues: false, results: [] },
        logoutRequests: 0,
        validationRequests: 0,
        ...overrides,
      };
      globalThis.fetch = Object.assign(
        mock(async (input: RequestInfo | URL): Promise<Response> => {
          const url = fetchUrl(input);
          if (url.includes('/review-queue')) return jsonResponse(completeWireBody(backend.reviewQueue));
          if (url.includes('/sessions/validate')) {
            backend.validationRequests += 1;
            return jsonResponse(completeWireBody(backend.validation));
          }
          if (url.includes('/auth/logout')) {
            backend.logoutRequests += 1;
            return jsonResponse({});
          }
          return jsonResponse({ todos: [] });
        }),
        { preconnect: () => {} },
      ) as typeof fetch;
      return backend;
    }

    const issues = { hasIssues: true, results: [{ sessionId: 's1', valid: false }] };

    function linkHrefs(): string[] {
      return within(screen.getByRole('navigation'))
        .getAllByRole('link')
        .map((a) => a.getAttribute('href') ?? '');
    }

    it('renders Review with its pending-count badge', async () => {
      installBackend({
        reviewQueue: [{ sourceSessionId: 's1', sourceSessionTitle: 'S1', items: [{ workerId: 'w1' }, { workerId: 'w2' }] }],
      });
      await renderWithRouter(<MobileNavMenu open={true} onClose={() => {}} />);

      const link = screen.getByText('Review').closest('a')!;
      expect(link.getAttribute('href')).toBe('/review');
      await waitFor(() => expect(within(link).getByText('2')).toBeTruthy());
    });

    it('lists the top group, then the menu group, in order (single-user)', async () => {
      installBackend();
      await renderWithRouter(<MobileNavMenu open={true} onClose={() => {}} />);
      expect(linkHrefs()).toEqual(['/todos', '/review', '/artifacts', '/settings', '/settings/repositories', '/agents', '/jobs']);
      expect(screen.getAllByRole('separator').length).toBe(1);
    });

    it('shows the Maintenance warning, between the top group and the menu group, only when issues exist', async () => {
      installBackend({ validation: issues });
      await renderWithRouter(<MobileNavMenu open={true} onClose={() => {}} />);

      await waitFor(() => expect(screen.getByRole('link', { name: '1' }).getAttribute('href')).toBe('/maintenance'));
      expect(linkHrefs()).toEqual([
        '/todos',
        '/review',
        '/artifacts',
        '/maintenance',
        '/settings',
        '/settings/repositories',
        '/agents',
        '/jobs',
      ]);
    });

    it('omits the Maintenance warning when the validation query reports no issues', async () => {
      const backend = installBackend();
      await renderWithRouter(<MobileNavMenu open={true} onClose={() => {}} />);
      // Let the validation answer arrive and settle before asserting the row is still absent.
      await waitFor(() => expect(backend.validationRequests).toBe(1));
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(linkHrefs()).not.toContain('/maintenance');
    });

    it('offers neither Shared accounts nor Logout in single-user mode', async () => {
      installBackend();
      await renderWithRouter(<MobileNavMenu open={true} onClose={() => {}} />);
      expect(screen.queryByText('Shared accounts')).toBeNull();
      expect(screen.queryByText('Logout')).toBeNull();
    });

    it('offers Shared accounts and a last Logout row in multi-user mode', async () => {
      installBackend();
      setAuthMode('multi-user');
      setCurrentUser({ id: 'user-me', username: 'me', homeDir: '/home/me' });
      await renderWithRouter(<MobileNavMenu open={true} onClose={() => {}} />);

      expect(screen.getByText('Shared accounts').closest('a')!.getAttribute('href')).toBe('/settings/shared-accounts');
      const nav = screen.getByRole('navigation');
      const last = nav.lastElementChild!;
      expect(last.textContent).toBe('Logout');
      expect(last.tagName).toBe('BUTTON');
      expect(screen.getAllByRole('separator').length).toBe(2);
    });

    it('runs the logout and closes the menu when Logout is pressed', async () => {
      const backend = installBackend();
      setAuthMode('multi-user');
      setCurrentUser({ id: 'user-me', username: 'me', homeDir: '/home/me' });
      const onClose = mock(() => {});
      await renderWithRouter(<MobileNavMenu open={true} onClose={onClose} />);

      fireEvent.click(screen.getByText('Logout'));

      expect(onClose).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(backend.logoutRequests).toBe(1));
    });

    describe.each([
      ['single-user', false],
      ['multi-user', true],
    ])('parity with NAV_ITEMS (%s)', (_label, multiUser) => {
      it('renders a link for every NAV_ITEMS destination visible in that mode and nothing else', async () => {
        installBackend();
        if (multiUser) {
          setAuthMode('multi-user');
          setCurrentUser({ id: 'user-me', username: 'me', homeDir: '/home/me' });
        }
        await renderWithRouter(<MobileNavMenu open={true} onClose={() => {}} />);

        const expected = navItemsForAuthMode(multiUser).map((item) => item.to);
        expect([...linkHrefs()].sort()).toEqual([...expected].sort());
        // Guard against the filter silently emptying: the multi-user list is the full list.
        if (multiUser) expect(expected.length).toBe(NAV_ITEMS.length);
      });

      it('adds only /maintenance on top of that set when issues exist', async () => {
        installBackend({ validation: issues });
        if (multiUser) {
          setAuthMode('multi-user');
          setCurrentUser({ id: 'user-me', username: 'me', homeDir: '/home/me' });
        }
        await renderWithRouter(<MobileNavMenu open={true} onClose={() => {}} />);
        await waitFor(() => expect(linkHrefs()).toContain('/maintenance'));

        const expected = [...navItemsForAuthMode(multiUser).map((item) => item.to), '/maintenance'];
        expect([...linkHrefs()].sort()).toEqual([...expected].sort());
      });
    });
  });
});
