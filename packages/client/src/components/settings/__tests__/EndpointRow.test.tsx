// NOTE: This test injects schema-derived fields (hasPreviousSecret,
// previousSecretExpiresAt) directly as props and DOES NOT exercise the
// WebSocket/valibot parse path. Schema-level wire validation lives in the
// api tests and packages/server route tests.
import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import { screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { InboundWebhookEndpoint } from '@agent-console/shared';
import { EndpointRow } from '../EndpointRow';
import { renderWithRouter } from '../../../test/renderWithRouter';
import { installFakeServer, makeEndpoint } from '../../../test/inbound-webhooks-fake-server';

const server = installFakeServer();
afterAll(() => server.restore());
beforeEach(() => server.reset());
afterEach(cleanup);

async function setup(endpoint: InboundWebhookEndpoint = makeEndpoint(), busy = false, rotateBlocked = false) {
  const handlers = {
    onRotate: mock((_e: InboundWebhookEndpoint) => {}),
    onClearPrevious: mock((_e: InboundWebhookEndpoint) => {}),
    onDelete: mock((_e: InboundWebhookEndpoint) => {}),
  };
  await renderWithRouter(
    <EndpointRow repositoryId="repo-1" endpoint={endpoint} busy={busy} rotateBlocked={rotateBlocked} {...handlers} />,
  );
  return handlers;
}

describe('EndpointRow', () => {
  it('renders the label, a multi-line instruction preserved with line breaks, the receive URL and an Edit link', async () => {
    await setup(makeEndpoint({ instructionText: 'first\nsecond' }));
    expect(screen.getByText('Slack alerts')).toBeTruthy();
    const instruction = screen.getByTestId('endpoint-instruction');
    expect(instruction.textContent).toBe('first\nsecond');
    expect(instruction.className).toContain('whitespace-pre-wrap');
    expect(instruction.className).toContain('line-clamp-4');
    expect(instruction.title).toBe('first\nsecond');
    await waitFor(() => expect(screen.getByText('https://hooks.example.com/webhooks/in/ep-1')).toBeTruthy());
    expect(screen.getByRole('link', { name: 'Edit' }).getAttribute('href')).toBe(
      '/settings/repositories/repo-1/inbound-webhooks/ep-1/edit',
    );
  });

  it('wires Rotate and Delete to their callbacks with the endpoint', async () => {
    const user = userEvent.setup();
    const endpoint = makeEndpoint();
    const h = await setup(endpoint);
    await user.click(screen.getByRole('button', { name: 'Rotate secret' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(h.onRotate).toHaveBeenCalledWith(endpoint);
    expect(h.onDelete).toHaveBeenCalledWith(endpoint);
  });

  it('shows the previous-secret controls only when hasPreviousSecret is true', async () => {
    const user = userEvent.setup();
    await setup();
    expect(screen.queryByRole('button', { name: 'End previous secret now' })).toBeNull();
    expect(screen.queryByText(/Previous secret still valid until/)).toBeNull();
    cleanup();

    const endpoint = makeEndpoint({ hasPreviousSecret: true, previousSecretExpiresAt: '2099-01-02T00:00:00.000Z' });
    const h = await setup(endpoint);
    expect(screen.getByText(/Previous secret still valid until/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'End previous secret now' }));
    expect(h.onClearPrevious).toHaveBeenCalledWith(endpoint);
  });

  it('disables Rotate, End previous and Delete while busy', async () => {
    await setup(makeEndpoint({ hasPreviousSecret: true, previousSecretExpiresAt: '2099-01-02T00:00:00.000Z' }), true);
    for (const name of ['Rotate secret', 'End previous secret now', 'Delete']) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('disables only Rotate when rotation is blocked; the other actions stay available', async () => {
    const user = userEvent.setup();
    const endpoint = makeEndpoint({ hasPreviousSecret: true, previousSecretExpiresAt: '2099-01-02T00:00:00.000Z' });
    const h = await setup(endpoint, false, true);
    expect((screen.getByRole('button', { name: 'Rotate secret' }) as HTMLButtonElement).disabled).toBe(true);
    for (const name of ['End previous secret now', 'Delete']) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(false);
    }
    await user.click(screen.getByRole('button', { name: 'Rotate secret' }));
    expect(h.onRotate).not.toHaveBeenCalled();
  });
});
