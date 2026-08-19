/**
 * Sibling test for the notification-bell placement change to
 * `MobileHeaderControls.tsx` (Notification Center Phase 2, Ruling 4). The
 * component's broader hamburger/sidebar behavior is already covered by
 * `routes/__tests__/__root.test.tsx`; this file exists to pin the one thing
 * that PR added -- the bell button must live in the always-visible control
 * cluster, NOT behind the collapsed `MobileNavMenu` (a badge hidden behind
 * a menu tap would defeat its purpose).
 */
import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { screen, cleanup } from '@testing-library/react';
import { renderWithRouter } from '../../../test/renderWithRouter';
import { MobileHeaderControls, type MobileHeaderControlsProps } from '../MobileHeaderControls';
import * as useAppWsModule from '../../../hooks/useAppWs';

const originalFetch = globalThis.fetch;

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const mockFetch = mock(async (): Promise<Response> =>
  jsonResponse({ items: [], lastSeenAt: null, unreadCount: 0 })
);

let useAppWsEventSpy: ReturnType<typeof spyOn>;
let useAppWsStateSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  globalThis.fetch = Object.assign(mockFetch, { preconnect: () => {} }) as typeof fetch;
  mockFetch.mockClear();
  useAppWsEventSpy = spyOn(useAppWsModule, 'useAppWsEvent').mockImplementation(() => undefined);
  useAppWsStateSpy = spyOn(useAppWsModule, 'useAppWsState').mockImplementation(<T,>() => false as T);
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  useAppWsEventSpy.mockRestore();
  useAppWsStateSpy.mockRestore();
});

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

describe('MobileHeaderControls / notification bell placement', () => {
  it('renders the notification bell in the always-visible control cluster (not behind the collapsed menu)', async () => {
    await renderWithRouter(<MobileHeaderControls {...defaultProps({ mobileNavOpen: false })} />);

    // The bell must be discoverable while the collapsed nav menu is closed --
    // i.e. it lives in the always-visible sibling div, not inside MobileNavMenu.
    const bellButton = screen.getByRole('button', { name: /notifications/i });
    expect(bellButton).toBeTruthy();

    // MobileNavMenu renders nothing (returns null) while closed, so the
    // bell being findable here already proves it is outside that menu; the
    // sessions and hamburger buttons remain its only visible siblings.
    expect(screen.getByLabelText('Open sessions')).toBeTruthy();
    expect(screen.getByLabelText('Open menu')).toBeTruthy();
  });

  it('keeps the notification bell visible even when the collapsed menu is open', async () => {
    await renderWithRouter(<MobileHeaderControls {...defaultProps({ mobileNavOpen: true })} />);

    expect(screen.getByRole('button', { name: /notifications/i })).toBeTruthy();
  });
});
