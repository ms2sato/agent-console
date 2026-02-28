import { describe, it, expect, mock, afterEach } from 'bun:test';
import { screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithRouter } from '../../../../test/renderWithRouter';
import { AgentDetailPending, AgentDetailError } from '../index';

afterEach(() => {
  cleanup();
});

describe('AgentDetailPending', () => {
  it('renders loading text with spinner', async () => {
    await renderWithRouter(<AgentDetailPending />);

    expect(screen.getByText('Loading agent...')).toBeTruthy();
    expect(screen.getByRole('status')).toBeTruthy();
  });
});

describe('AgentDetailError', () => {
  it('renders the error message', async () => {
    const reset = mock(() => {});
    const error = new Error('Failed to fetch agent: Not Found');
    await renderWithRouter(<AgentDetailError error={error} reset={reset} />);

    expect(screen.getByText('Failed to load agent')).toBeTruthy();
    expect(screen.getByText('Failed to fetch agent: Not Found')).toBeTruthy();
  });

  it('calls reset when Retry is clicked', async () => {
    const reset = mock(() => {});
    await renderWithRouter(
      <AgentDetailError error={new Error('error')} reset={reset} />
    );

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('renders Back to Agents link', async () => {
    await renderWithRouter(
      <AgentDetailError error={new Error('error')} reset={mock(() => {})} />
    );

    expect(screen.getByRole('link', { name: 'Back to Agents' })).toBeTruthy();
  });
});
