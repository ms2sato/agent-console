import { describe, it, expect, mock, afterEach } from 'bun:test';
import { screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithRouter } from '../../../../test/renderWithRouter';
import { JobDetailPending, JobDetailError } from '../index';

afterEach(() => {
  cleanup();
});

describe('JobDetailPending', () => {
  it('renders loading text with spinner', async () => {
    await renderWithRouter(<JobDetailPending />);

    expect(screen.getByText('Loading job...')).toBeTruthy();
    expect(screen.getByRole('status')).toBeTruthy();
  });
});

describe('JobDetailError', () => {
  it('renders the error message', async () => {
    const reset = mock(() => {});
    const error = new Error('Job not found: 404');
    await renderWithRouter(<JobDetailError error={error} reset={reset} />);

    expect(screen.getByText('Failed to load job')).toBeTruthy();
    expect(screen.getByText('Job not found: 404')).toBeTruthy();
  });

  it('calls reset when Retry is clicked', async () => {
    const reset = mock(() => {});
    await renderWithRouter(
      <JobDetailError error={new Error('error')} reset={reset} />
    );

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('renders Back to Jobs link', async () => {
    await renderWithRouter(
      <JobDetailError error={new Error('error')} reset={mock(() => {})} />
    );

    expect(screen.getByRole('link', { name: 'Back to Jobs' })).toBeTruthy();
  });
});
