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
      <NotificationPanel items={[]} isLoading={true} isError={false} onRetry={mock(() => {})} onNavigate={mock(() => {})} />
    );

    expect(screen.getByText(/loading/i)).toBeTruthy();
  });

  it('shows the empty-state copy when there are no items', async () => {
    await renderWithRouter(
      <NotificationPanel items={[]} isLoading={false} isError={false} onRetry={mock(() => {})} onNavigate={mock(() => {})} />
    );

    expect(screen.getByText(/no notifications yet/i)).toBeTruthy();
    // Negative arm: a genuinely-empty feed must never render the error copy.
    expect(screen.queryByText(/failed to load notifications/i)).toBeNull();
  });

  it('renders every item passed in props', async () => {
    const items = makeItems(3);
    await renderWithRouter(
      <NotificationPanel items={items} isLoading={false} isError={false} onRetry={mock(() => {})} onNavigate={mock(() => {})} />
    );

    for (const item of items) {
      expect(screen.getByText(item.title)).toBeTruthy();
    }
  });

  it('renders all 50 items when the server returns the capped page', async () => {
    // unreadCount > items.length is a badge-only concern (Ruling 2); the
    // panel itself only ever renders what it is given.
    const items = makeItems(50);
    await renderWithRouter(
      <NotificationPanel items={items} isLoading={false} isError={false} onRetry={mock(() => {})} onNavigate={mock(() => {})} />
    );

    const rows = screen.getAllByTestId('notification-item');
    expect(rows.length).toBe(50);
  });

  it('shows the error copy with a Retry button, and never the empty-state copy, when isError is true', async () => {
    const onRetry = mock(() => {});
    await renderWithRouter(
      <NotificationPanel items={[]} isLoading={false} isError={true} onRetry={onRetry} onNavigate={mock(() => {})} />
    );

    expect(screen.getByText(/failed to load notifications/i)).toBeTruthy();
    // The point of this test: an error must not be collapsed into the
    // empty-state copy -- the two states must stay distinguishable.
    expect(screen.queryByText(/no notifications yet/i)).toBeNull();

    screen.getByRole('button', { name: /retry/i }).click();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
