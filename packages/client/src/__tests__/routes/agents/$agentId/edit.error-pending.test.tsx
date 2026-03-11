import { describe, it, expect, mock, afterEach } from 'bun:test';
import { screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithRouter } from '../../../../test/renderWithRouter';
import { AgentEditPending, AgentEditError } from '../../../../routes/agents/$agentId/edit';

afterEach(() => {
  cleanup();
});

describe('AgentEditPending', () => {
  it('renders loading text with spinner', async () => {
    await renderWithRouter(<AgentEditPending />);

    expect(screen.getByText('Loading agent...')).toBeTruthy();
    expect(screen.getByRole('status')).toBeTruthy();
  });
});

describe('AgentEditError', () => {
  it('renders the error message', async () => {
    const reset = mock(() => {});
    const error = new Error('Agent not found: 404');
    await renderWithRouter(<AgentEditError error={error} reset={reset} />);

    expect(screen.getByText('Failed to load agent')).toBeTruthy();
    expect(screen.getByText('Agent not found: 404')).toBeTruthy();
  });

  it('calls reset when Retry is clicked', async () => {
    const reset = mock(() => {});
    await renderWithRouter(
      <AgentEditError error={new Error('error')} reset={reset} />
    );

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('renders Back to Agents link', async () => {
    await renderWithRouter(
      <AgentEditError error={new Error('error')} reset={mock(() => {})} />
    );

    expect(screen.getByRole('link', { name: 'Back to Agents' })).toBeTruthy();
  });
});
