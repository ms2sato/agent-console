import { describe, it, expect, mock, afterEach } from 'bun:test';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CopyButton } from '../CopyButton';

afterEach(cleanup);

describe('CopyButton', () => {
  it('writes the text and shows Copied', async () => {
    const user = userEvent.setup();
    const writeText = mock((_t: string) => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<CopyButton text="abc" />);
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('abc');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy());
  });

  it('reports a refused write without throwing and keeps the label', async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('no')) }, configurable: true });
    render(<CopyButton text="abc" />);
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(screen.getByText(/Could not copy automatically/)).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
  });
});
