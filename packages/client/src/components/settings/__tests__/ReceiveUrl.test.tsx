import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import { screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReceiveUrl, RECEIVE_URL_UNSET_HINT } from '../ReceiveUrl';
import { renderWithRouter } from '../../../test/renderWithRouter';
import { installFakeServer } from '../../../test/inbound-webhooks-fake-server';

const server = installFakeServer();
afterAll(() => server.restore());
beforeEach(() => server.reset());
afterEach(cleanup);

describe('ReceiveUrl', () => {
  it('shows <origin>/webhooks/in/<id> and copies it, with no hint, when the origin is set', async () => {
    const writeText = mock((_t: string) => Promise.resolve());
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await renderWithRouter(<ReceiveUrl endpointId="abc" />);

    await waitFor(() => expect(screen.getByText('https://hooks.example.com/webhooks/in/abc')).toBeTruthy());
    expect(screen.queryByText(RECEIVE_URL_UNSET_HINT)).toBeNull();
    await user.click(within(screen.getByTestId('receive-url')).getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('https://hooks.example.com/webhooks/in/abc');
  });

  it('shows the path, the exact hint and copies the path when the origin is null', async () => {
    server.internetOrigin = null;
    const writeText = mock((_t: string) => Promise.resolve());
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await renderWithRouter(<ReceiveUrl endpointId="abc" />);

    await waitFor(() => expect(screen.getByText(RECEIVE_URL_UNSET_HINT)).toBeTruthy());
    expect(RECEIVE_URL_UNSET_HINT).toBe('Set AGENT_CONSOLE_INTERNET_ORIGIN on the server to show the full URL');
    expect(screen.getByText('/webhooks/in/abc')).toBeTruthy();
    await user.click(within(screen.getByTestId('receive-url')).getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('/webhooks/in/abc');
  });

  it('does not show the hint before the health read has answered', async () => {
    server.internetOrigin = null;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const base = server.mockFetch.getMockImplementation()!;
    server.mockFetch.mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes('/api/system/health')) await gate;
      return base(input, init);
    });
    await renderWithRouter(<ReceiveUrl endpointId="abc" />);

    expect(screen.getByText('/webhooks/in/abc')).toBeTruthy();
    expect(screen.queryByText(RECEIVE_URL_UNSET_HINT)).toBeNull();
    release();
    await waitFor(() => expect(screen.getByText(RECEIVE_URL_UNSET_HINT)).toBeTruthy());
    server.mockFetch.mockImplementation(base);
  });

  it('reports a clipboard refusal instead of throwing', async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('no')) }, configurable: true });
    await renderWithRouter(<ReceiveUrl endpointId="abc" />);
    await user.click(await screen.findByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(screen.getByText(/Could not copy automatically/)).toBeTruthy());
  });
});
