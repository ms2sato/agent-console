import { describe, it, expect, mock, afterEach } from 'bun:test';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SecretRevealPanel } from '../SecretRevealPanel';

afterEach(cleanup);

describe('SecretRevealPanel', () => {
  it('shows the secret with a one-time warning and calls onDismiss from the default action', async () => {
    const onDismiss = mock(() => {});
    render(<SecretRevealPanel endpointLabel="Alerts" secret="whsec_abc" onDismiss={onDismiss} />);

    expect(screen.getByTestId('issued-secret').textContent).toBe('whsec_abc');
    expect(screen.getByText(/cannot be shown again/)).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('button', { name: 'I have saved the secret' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('renders children and a custom action in place of the default button', () => {
    render(
      <SecretRevealPanel endpointLabel="Alerts" secret="whsec_abc" action={<a href="/done">Done</a>}>
        <span>child content</span>
      </SecretRevealPanel>,
    );
    expect(screen.getByText('child content')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Done' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'I have saved the secret' })).toBeNull();
  });

  it('Copy writes the secret; a clipboard failure is reported without throwing', async () => {
    const user = userEvent.setup();
    const writeText = mock((_t: string) => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<SecretRevealPanel endpointLabel="Alerts" secret="whsec_abc" onDismiss={() => {}} />);
    await user.click(within(screen.getByTestId('secret-block')).getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('whsec_abc');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy());

    cleanup();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('no')) }, configurable: true });
    render(<SecretRevealPanel endpointLabel="Alerts" secret="whsec_abc" onDismiss={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(screen.getByText(/Could not copy automatically/)).toBeTruthy());
  });
});
