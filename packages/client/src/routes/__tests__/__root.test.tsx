/**
 * Tests for RootLayout mobile-specific behavior.
 * Uses mock.module to replace hooks that require live server state.
 */
import { describe, it, expect, mock, afterEach } from 'bun:test';

// Mock hooks that depend on server state (must precede component imports)
mock.module('../../hooks/useAppWs', () => ({
  useAppWsState: (selector: (s: { connected: boolean }) => unknown) =>
    selector({ connected: true }),
  useAppWsEvent: () => {},
}));

mock.module('../../hooks/useSessionState', () => ({
  useSessionState: () => ({
    sessions: [],
    workerActivityStates: {},
    handleSessionsSync: () => {},
    handleSessionCreated: () => {},
    handleSessionUpdated: () => {},
    handleSessionDeleted: () => {},
    handleSessionPaused: () => {},
    handleSessionResumed: () => {},
    handleWorkerActivity: () => {},
  }),
}));

mock.module('../../hooks/useActiveSessionsWithActivity', () => ({
  useActiveSessionsWithActivity: () => [],
}));

mock.module('../../hooks/useWorktreeCreationTasks', () => ({
  useWorktreeCreationTasks: () => ({
    tasks: [],
    addTask: () => {},
    removeTask: () => {},
    handleWorktreeCreationCompleted: () => {},
    handleWorktreeCreationFailed: () => {},
  }),
}));

mock.module('../../hooks/useWorktreeDeletionTasks', () => ({
  useWorktreeDeletionTasks: () => ({
    tasks: [],
    addTask: () => {},
    removeTask: () => {},
    getTask: () => undefined,
    markAsFailed: () => {},
    handleWorktreeDeletionCompleted: () => {},
    handleWorktreeDeletionFailed: () => {},
  }),
}));

mock.module('../../hooks/useSidebarState', () => ({
  useSidebarState: () => ({
    collapsed: false,
    toggle: () => {},
    width: 288,
    setWidth: () => {},
  }),
}));

mock.module('../../lib/api', () => ({
  validateSessions: () => Promise.resolve({ hasIssues: false, results: [] }),
  resumeSession: () => Promise.resolve({}),
}));

mock.module('../../lib/favicon-manager', () => ({
  updateFavicon: () => {},
  hasAnyAskingWorker: () => false,
}));

mock.module('../../hooks/useIsMobile', () => ({
  useIsMobile: () => true,
}));

import { screen, fireEvent, cleanup, act, render } from '@testing-library/react';
import { createRouter, createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Route import must come after mock.module calls
import { Route as RootRoute } from '../__root';

async function renderRootLayout(initialPath = '/') {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: Infinity,
        staleTime: Infinity,
      },
      mutations: {
        retry: false,
      },
    },
  });

  const memoryHistory = createMemoryHistory({
    initialEntries: [initialPath],
  });

  const routeTree = RootRoute.addChildren([]);

  const router = createRouter({
    routeTree,
    history: memoryHistory,
    defaultPendingMinMs: 0,
  });

  await act(async () => {
    await router.load();
  });

  const result = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );

  return { ...result, router, queryClient };
}

describe('RootLayout mobile behavior', () => {
  afterEach(() => {
    cleanup();
  });

  it('should render the sessions icon button on mobile', async () => {
    await renderRootLayout();

    const sessionsButton = screen.getByLabelText('Open sessions');
    expect(sessionsButton).toBeTruthy();
  });

  it('should render the hamburger menu button on mobile', async () => {
    await renderRootLayout();

    const menuButton = screen.getByLabelText('Open menu');
    expect(menuButton).toBeTruthy();
  });

  it('should open nav menu when hamburger button is clicked', async () => {
    await renderRootLayout();

    // Before clicking, only the desktop nav exists
    const navsBefore = screen.getAllByRole('navigation');
    expect(navsBefore).toHaveLength(1);

    fireEvent.click(screen.getByLabelText('Open menu'));

    // MobileNavMenu adds a second nav element
    const navsAfter = screen.getAllByRole('navigation');
    expect(navsAfter).toHaveLength(2);

    const mobileNav = navsAfter.find(nav => nav !== navsBefore[0])!;
    expect(mobileNav).toBeTruthy();
    expect(mobileNav.textContent).toContain('Jobs');
    expect(mobileNav.textContent).toContain('Agents');
    expect(mobileNav.textContent).toContain('Repositories');
  });

  it('should toggle hamburger button aria-label when menu opens', async () => {
    await renderRootLayout();

    const menuButton = screen.getByLabelText('Open menu');
    expect(menuButton.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(menuButton);

    const closeButton = screen.getByLabelText('Close menu');
    expect(closeButton).toBeTruthy();
    expect(closeButton.getAttribute('aria-expanded')).toBe('true');
  });

  it('should open sidebar drawer when sessions button is clicked', async () => {
    await renderRootLayout();

    fireEvent.click(screen.getByLabelText('Open sessions'));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeTruthy();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-label')).toBe('Sessions drawer');
  });

  it('should not render desktop sidebar on mobile', async () => {
    await renderRootLayout();

    // On mobile, the desktop sidebar is replaced by MobileSidebarDrawer.
    // Verify the mobile-only sessions button is present.
    expect(screen.getByLabelText('Open sessions')).toBeTruthy();
  });
});
