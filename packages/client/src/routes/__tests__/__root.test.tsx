/**
 * Tests for MobileHeaderControls component.
 * Tests mobile header behavior (hamburger menu, sessions button, nav menu)
 * using a props-based component to avoid mock.module() entirely.
 */
import { describe, it, expect, mock, afterEach, beforeEach } from 'bun:test';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { createRoute, createRouter, createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderWithRouter } from '../../test/renderWithRouter';
import { waitForAbsent } from '../../test/waitForAbsent';
import { installMockWebSocket } from '../../test/mock-websocket';
import { _reset as resetWebSocket } from '../../lib/app-websocket';
import { _reset as resetAuth } from '../../lib/auth';
import { Route as RootRoute, useSessionStopTasksContext } from '../__root';
import { MobileHeaderControls, type MobileHeaderControlsProps } from '../../components/header/MobileHeaderControls';

function defaultProps(overrides: Partial<MobileHeaderControlsProps> = {}): MobileHeaderControlsProps {
  return {
    mobileNavOpen: false,
    mobileSidebarOpen: false,
    hasAnyAsking: false,
    onOpenSidebar: mock(() => {}),
    onCloseSidebar: mock(() => {}),
    onToggleNav: mock(() => {}),
    onCloseNav: mock(() => {}),
    sidebarContent: <div>Sidebar content</div>,
    ...overrides,
  };
}

describe('MobileHeaderControls', () => {
  afterEach(() => {
    cleanup();
  });

  it('should render the sessions icon button', async () => {
    await renderWithRouter(<MobileHeaderControls {...defaultProps()} />);
    const sessionsButton = screen.getByLabelText('Open sessions');
    expect(sessionsButton).toBeTruthy();
  });

  it('should render the hamburger menu button', async () => {
    await renderWithRouter(<MobileHeaderControls {...defaultProps()} />);
    const menuButton = screen.getByLabelText('Open menu');
    expect(menuButton).toBeTruthy();
  });

  it('should show nav menu when mobileNavOpen is true', async () => {
    await renderWithRouter(<MobileHeaderControls {...defaultProps({ mobileNavOpen: true })} />);
    const nav = screen.getByRole('navigation');
    expect(nav).toBeTruthy();
    expect(nav.textContent).toContain('Jobs');
    expect(nav.textContent).toContain('Agents');
    expect(nav.textContent).toContain('Repositories');
  });

  it('should call onToggleNav when hamburger button is clicked', async () => {
    const onToggleNav = mock(() => {});
    await renderWithRouter(<MobileHeaderControls {...defaultProps({ onToggleNav })} />);
    fireEvent.click(screen.getByLabelText('Open menu'));
    expect(onToggleNav).toHaveBeenCalledTimes(1);
  });

  it('should toggle hamburger button aria-label based on mobileNavOpen', async () => {
    await renderWithRouter(<MobileHeaderControls {...defaultProps({ mobileNavOpen: false })} />);
    const menuButton = screen.getByLabelText('Open menu');
    expect(menuButton.getAttribute('aria-expanded')).toBe('false');
  });

  it('should show Close menu label when nav is open', async () => {
    await renderWithRouter(<MobileHeaderControls {...defaultProps({ mobileNavOpen: true })} />);
    const closeButton = screen.getByLabelText('Close menu');
    expect(closeButton).toBeTruthy();
    expect(closeButton.getAttribute('aria-expanded')).toBe('true');
  });

  it('should call onOpenSidebar when sessions button is clicked', async () => {
    const onOpenSidebar = mock(() => {});
    await renderWithRouter(<MobileHeaderControls {...defaultProps({ onOpenSidebar })} />);
    fireEvent.click(screen.getByLabelText('Open sessions'));
    expect(onOpenSidebar).toHaveBeenCalledTimes(1);
  });

  it('should show sidebar drawer when mobileSidebarOpen is true', async () => {
    await renderWithRouter(<MobileHeaderControls {...defaultProps({ mobileSidebarOpen: true })} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeTruthy();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-label')).toBe('Sessions drawer');
  });
});

function HookFailureTrigger({ kind }: { kind: 'pause' | 'resume' }) {
  const { reportHookFailure } = useSessionStopTasksContext();
  return (
    <button
      onClick={() =>
        reportHookFailure({ kind, sessionTitle: 'qa session', result: { success: false, error: 'boom' } })
      }
    >
      Report failure
    </button>
  );
}

describe('RootLayout hook failure dialog', () => {
  const originalFetch = globalThis.fetch;
  let restoreWebSocket: () => void;

  beforeEach(() => {
    globalThis.fetch = Object.assign(
      async () => new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      { preconnect: () => {} },
    ) as typeof fetch;
    restoreWebSocket = installMockWebSocket();
    resetWebSocket();
    // RootLayout redirects an unauthenticated user to /login in multi-user mode, and the
    // auth state is module-global: a file that ran earlier in the same process and left it
    // in multi-user mode would send this harness to a route it does not define.
    resetAuth();
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    restoreWebSocket();
    resetAuth();
  });

  async function mountRootLayout(kind: 'pause' | 'resume') {
    // The real root route (its component is RootLayout) with one child that
    // reports a hook failure through the context RootLayout provides.
    const childRoute = createRoute({
      getParentRoute: () => RootRoute,
      path: '/',
      component: () => <HookFailureTrigger kind={kind} />,
    });
    const router = createRouter({
      routeTree: RootRoute.addChildren([childRoute]),
      history: createMemoryHistory({ initialEntries: ['/'] }),
      defaultPendingMinMs: 0,
    });
    await act(async () => {
      await router.load();
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      render(
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      );
    });
  }

  // Polarity (measured): with the <SessionHookFailureDialog /> element deleted
  // from the root layout, both tests in this describe fail ("shows a failed
  // pause command over the current page and dismisses on OK" and "shows a
  // failed resume command with the resume title"); restored, both pass.
  it('shows a failed pause command over the current page and dismisses on OK', async () => {
    await mountRootLayout('pause');
    fireEvent.click(await screen.findByText('Report failure'));

    expect(await screen.findByText('Pause Command Failed')).toBeTruthy();
    expect(screen.getByText('boom')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await waitForAbsent(() => screen.queryByText('Pause Command Failed'));
    await waitForAbsent(() => screen.queryByText('boom'));
  });

  it('shows a failed resume command with the resume title', async () => {
    await mountRootLayout('resume');
    fireEvent.click(await screen.findByText('Report failure'));
    expect(await screen.findByText('Resume Command Failed')).toBeTruthy();
  });
});
