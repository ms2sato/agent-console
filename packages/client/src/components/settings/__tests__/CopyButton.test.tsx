import { describe, it, expect, mock, afterEach } from 'bun:test';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CopyButton } from '../CopyButton';

const originalIsSecureContext = Object.getOwnPropertyDescriptor(window, 'isSecureContext');

function setSecureContext(value: boolean) {
  Object.defineProperty(window, 'isSecureContext', { value, writable: true, configurable: true });
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(document, 'execCommand');
  if (originalIsSecureContext) {
    Object.defineProperty(window, 'isSecureContext', originalIsSecureContext);
  } else {
    Reflect.deleteProperty(window, 'isSecureContext');
  }
});

describe('CopyButton', () => {
  it('writes the text and shows Copied', async () => {
    const user = userEvent.setup();
    const writeText = mock((_t: string) => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    setSecureContext(true);
    render(<CopyButton text="abc" />);
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('abc');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy());
  });

  it('copies via the execCommand fallback in a non-secure context and shows Copied', async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    setSecureContext(false);
    const execCommand = mock((_c: string) => true);
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true });
    render(<CopyButton text="abc" />);
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(execCommand).toHaveBeenCalledWith('copy');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy());
  });

  it('reports a refused write without throwing and keeps the label', async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('no')) }, configurable: true });
    setSecureContext(true);
    Object.defineProperty(document, 'execCommand', { value: () => false, configurable: true });
    render(<CopyButton text="abc" />);
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(screen.getByText(/Could not copy automatically/)).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
  });

  it('reports failure in a non-secure context when the fallback fails', async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    setSecureContext(false);
    Object.defineProperty(document, 'execCommand', { value: () => false, configurable: true });
    render(<CopyButton text="abc" />);
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(screen.getByText(/Could not copy automatically/)).toBeTruthy());
  });
});
