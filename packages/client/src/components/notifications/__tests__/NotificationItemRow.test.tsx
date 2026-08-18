import { describe, it, expect, afterEach, mock } from 'bun:test';
import { screen, cleanup } from '@testing-library/react';
import type { NotificationItem } from '@agent-console/shared';
import { renderWithRouter } from '../../../test/renderWithRouter';
import { NotificationItemRow } from '../NotificationItemRow';

afterEach(() => {
  cleanup();
});

const artifactItem: NotificationItem = {
  kind: 'artifact-created',
  id: 'artifact-1',
  occurredAt: new Date().toISOString(),
  title: 'My Dashboard',
  link: '/artifacts/artifact-1',
};

const completedDeletionItem: NotificationItem = {
  kind: 'worktree-deletion-finished',
  id: 'job-1',
  occurredAt: new Date().toISOString(),
  title: 'Worktree deleted: feature-branch',
  link: '/worktree-deletion-tasks/job-1',
  outcome: 'completed',
};

const failedDeletionItem: NotificationItem = {
  kind: 'worktree-deletion-finished',
  id: 'job-2',
  occurredAt: new Date().toISOString(),
  title: 'Worktree deletion failed: feature-branch',
  link: '/worktree-deletion-tasks/job-2',
  outcome: 'failed',
};

describe('NotificationItemRow', () => {
  it('renders an artifact-created item as a plain full-document anchor (#1340 jail rule)', async () => {
    await renderWithRouter(<NotificationItemRow item={artifactItem} onNavigate={mock(() => {})} />);

    const link = screen.getByText('My Dashboard').closest('a')!;
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe('/artifacts/artifact-1');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('renders a worktree-deletion-finished item as an SPA Link', async () => {
    await renderWithRouter(<NotificationItemRow item={completedDeletionItem} onNavigate={mock(() => {})} />);

    const link = screen.getByText('Worktree deleted: feature-branch').closest('a')!;
    expect(link.getAttribute('href')).toBe('/worktree-deletion-tasks/job-1');
    // SPA link must NOT force a full-document navigation.
    expect(link.getAttribute('target')).not.toBe('_blank');
  });

  it('renders a completed deletion without failure styling', async () => {
    await renderWithRouter(<NotificationItemRow item={completedDeletionItem} onNavigate={mock(() => {})} />);

    const title = screen.getByText('Worktree deleted: feature-branch');
    expect(title.className).not.toContain('text-red-400');
  });

  it('renders a failed deletion visually distinguishable from a completed one', async () => {
    await renderWithRouter(<NotificationItemRow item={failedDeletionItem} onNavigate={mock(() => {})} />);

    const title = screen.getByText('Worktree deletion failed: feature-branch');
    expect(title.className).toContain('text-red-400');
    const link = title.closest('a')!;
    expect(link.className).toContain('border-red-500');
  });

  it('calls onNavigate when the row is activated', async () => {
    const onNavigate = mock(() => {});
    await renderWithRouter(<NotificationItemRow item={artifactItem} onNavigate={onNavigate} />);

    const link = screen.getByText('My Dashboard').closest('a')!;
    link.click();

    expect(onNavigate).toHaveBeenCalledTimes(1);
  });
});
