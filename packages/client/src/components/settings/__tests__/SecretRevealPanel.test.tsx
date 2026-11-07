import { describe, it, expect, mock, afterEach } from 'bun:test';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SecretRevealPanel } from '../SecretRevealPanel';

afterEach(cleanup);

describe('SecretRevealPanel', () => {
  it('shows the secret with a one-time warning and calls onDismiss', async () => {
    const onDismiss = mock(() => {});
    render(<SecretRevealPanel endpointLabel="Alerts" secret="whsec_abc" onDismiss={onDismiss} />);

    expect(screen.getByTestId('issued-secret').textContent).toBe('whsec_abc');
    expect(screen.getByText(/cannot be shown again/)).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('button', { name: 'I have saved the secret' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('reports a clipboard failure without throwing', async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new Error('no')) },
      configurable: true,
    });
    render(<SecretRevealPanel endpointLabel="Alerts" secret="whsec_abc" onDismiss={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(screen.getByText(/Could not copy automatically/)).toBeTruthy());
  });
});
