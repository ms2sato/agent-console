import { describe, it, expect, mock, afterEach } from 'bun:test';
import { screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithRouter } from '../../../../../test/renderWithRouter';
import { RepositoryDetailPending, RepositoryDetailError } from '../../../../../routes/settings/repositories/$repositoryId/index';

afterEach(() => {
  cleanup();
});

describe('RepositoryDetailPending', () => {
  it('renders loading text with spinner', async () => {
    await renderWithRouter(<RepositoryDetailPending />);

    expect(screen.getByText('Loading repository...')).toBeTruthy();
    expect(screen.getByRole('status')).toBeTruthy();
  });
});

describe('RepositoryDetailError', () => {
  it('renders the error message', async () => {
    const reset = mock(() => {});
    const error = new Error('Repository not found: repo-123');
    await renderWithRouter(<RepositoryDetailError error={error} reset={reset} />);

    expect(screen.getByText('Failed to load repository')).toBeTruthy();
    expect(screen.getByText('Repository not found: repo-123')).toBeTruthy();
  });

  it('calls reset when Retry is clicked', async () => {
    const reset = mock(() => {});
    await renderWithRouter(
      <RepositoryDetailError error={new Error('error')} reset={reset} />
    );

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('renders Back to Repositories link', async () => {
    await renderWithRouter(
      <RepositoryDetailError error={new Error('error')} reset={mock(() => {})} />
    );

    const link = screen.getByRole('link', { name: 'Back to Repositories' });
    expect(link).toBeTruthy();
    expect(link.getAttribute('href')).toBe('/settings/repositories');
  });
});
