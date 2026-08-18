import { describe, it, expect, afterEach, mock } from 'bun:test';
import { screen, cleanup } from '@testing-library/react';
import type { NotificationItem } from '@agent-console/shared';
import { renderWithRouter } from '../../../test/renderWithRouter';
import { NotificationPanel } from '../NotificationPanel';

afterEach(() => {
  cleanup();
});

function makeItems(count: number): NotificationItem[] {
  return Array.from({ length: count }, (_, i) => ({
    kind: 'artifact-created' as const,
    id: `artifact-${i}`,
    occurredAt: new Date(Date.now() - i * 1000).toISOString(),
    title: `Artifact ${i}`,
    link: `/artifacts/artifact-${i}`,
  }));
}

describe('NotificationPanel', () => {
  it('shows a loading state while fetching', async () => {
    await renderWithRouter(
      <NotificationPanel items={[]} isLoading={true} onNavigate={mock(() => {})} />
    );

    expect(screen.getByText(/loading/i)).toBeTruthy();
  });

  it('shows the empty-state copy when there are no items', async () => {
    await renderWithRouter(
      <NotificationPanel items={[]} isLoading={false} onNavigate={mock(() => {})} />
    );

    expect(screen.getByText(/no notifications yet/i)).toBeTruthy();
  });

  it('renders every item passed in props', async () => {
    const items = makeItems(3);
    await renderWithRouter(
      <NotificationPanel items={items} isLoading={false} onNavigate={mock(() => {})} />
    );

    for (const item of items) {
      expect(screen.getByText(item.title)).toBeTruthy();
    }
  });

  it('renders exactly the 50-item cap even when more are unread (51 unread / 50 items case)', async () => {
    // unreadCount > items.length is a badge-only concern (Ruling 2); the
    // panel itself only ever renders what it is given.
    const items = makeItems(50);
    await renderWithRouter(
      <NotificationPanel items={items} isLoading={false} onNavigate={mock(() => {})} />
    );

    const rows = screen.getAllByTestId('notification-item');
    expect(rows.length).toBe(50);
  });
});
