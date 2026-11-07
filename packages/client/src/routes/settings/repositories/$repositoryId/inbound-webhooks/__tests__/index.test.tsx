// NOTE: These tests inject wire fields (hasPreviousSecret, previousSecretExpiresAt,
// secretSource) through a fake server's JSON bodies. The client's api layer DOES
// parse them with the shared valibot schemas, but the real server serializer is
// not exercised. Schema-level wire validation of the server side lives in the
// server route tests and packages/integration. Adding a new derived field
// requires updating BOTH places.
import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import { Suspense } from 'react';
import { screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { InboundWebhooksListView } from '../index';
import { renderWithRouter } from '../../../../../../test/renderWithRouter';
import { waitForAbsent } from '../../../../../../test/waitForAbsent';
import { installFakeServer, makeEndpoint } from '../../../../../../test/inbound-webhooks-fake-server';
import { findSecretHolders } from '../../../../../../test/assert-no-secret';

const server = installFakeServer();
afterAll(() => server.restore());
beforeEach(() => {
  server.reset();
  server.mockFetch.mockClear();
});
afterEach(cleanup);

const ENTERED = `whsec_${Buffer.alloc(32, 9).toString('base64')}`;

function renderList() {
  return renderWithRouter(
    <Suspense fallback={<div>Loading...</div>}>
      <InboundWebhooksListView repositoryId="repo-1" />
    </Suspense>,
  );
}

const rotateButtons = () => screen.getAllByRole('button', { name: 'Rotate secret' }) as HTMLButtonElement[];
const rotatePosts = () => server.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/rotate-secret'));

describe('InboundWebhooksListView', () => {
  it('lists endpoints with label, multi-line instruction, receive URL, Edit link and the in-development note', async () => {
    server.endpoints = [makeEndpoint({ instructionText: 'line one\nline two' })];
    await renderList();

    await waitFor(() => expect(screen.getByText('Slack alerts')).toBeTruthy());
    expect(screen.getByTestId('endpoint-instruction').textContent).toBe('line one\nline two');
    expect(screen.getByTestId('endpoint-instruction').className).toContain('whitespace-pre-wrap');
    expect(screen.getByText(/Receiving is not active yet \(in development\)/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Edit' }).getAttribute('href')).toBe(
      '/settings/repositories/repo-1/inbound-webhooks/ep-1/edit',
    );
    expect(screen.getByRole('link', { name: 'New endpoint' }).getAttribute('href')).toBe(
      '/settings/repositories/repo-1/inbound-webhooks/new',
    );
    expect(screen.queryByText(/whsec_/)).toBeNull();
  });

  it('shows the full receive URL on the row when the origin is set, and Copy copies it', async () => {
    const writeText = mock((_t: string) => Promise.resolve());
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await renderList();

    const url = within(await screen.findByTestId('receive-url'));
    await waitFor(() => expect(url.getByText('https://hooks.example.com/webhooks/in/ep-1')).toBeTruthy());
    expect(screen.queryByText(/Set AGENT_CONSOLE_INTERNET_ORIGIN/)).toBeNull();
    await user.click(url.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('https://hooks.example.com/webhooks/in/ep-1');
  });

  it('shows the path plus the hint when the origin is unset, and Copy copies the path', async () => {
    server.internetOrigin = null;
    const writeText = mock((_t: string) => Promise.resolve());
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await renderList();

    const url = within(await screen.findByTestId('receive-url'));
    await waitFor(() =>
      expect(url.getByText('Set AGENT_CONSOLE_INTERNET_ORIGIN on the server to show the full URL')).toBeTruthy(),
    );
    expect(url.getByText('/webhooks/in/ep-1')).toBeTruthy();
    await user.click(url.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('/webhooks/in/ep-1');
  });

  it('shows an empty state and an error state with Retry', async () => {
    server.endpoints = [];
    await renderList();
    await waitFor(() => expect(screen.getByText('No inbound webhook endpoints yet')).toBeTruthy());
    cleanup();

    server.endpoints = [makeEndpoint()];
    server.listStatus = 500;
    await renderList();
    await waitFor(() => expect(screen.getByText('Failed to load inbound webhook endpoints')).toBeTruthy());
    server.listStatus = 200;
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText('Slack alerts')).toBeTruthy());
  });

  it('shows the previous-secret indicator and End previous secret now only while hasPreviousSecret', async () => {
    server.endpoints = [
      makeEndpoint(),
      makeEndpoint({ id: 'ep-2', label: 'Other', hasPreviousSecret: true, previousSecretExpiresAt: '2099-01-02T00:00:00.000Z' }),
    ];
    const user = userEvent.setup();
    await renderList();

    await waitFor(() => expect(screen.getByText('Other')).toBeTruthy());
    expect(within(screen.getByTestId('endpoint-ep-1')).queryByText(/Previous secret still valid until/)).toBeNull();
    expect(within(screen.getByTestId('endpoint-ep-1')).queryByRole('button', { name: 'End previous secret now' })).toBeNull();
    const row2 = within(screen.getByTestId('endpoint-ep-2'));
    expect(row2.getByText(/Previous secret still valid until/)).toBeTruthy();

    await user.click(row2.getByRole('button', { name: 'End previous secret now' }));
    await waitForAbsent(() => screen.queryByRole('button', { name: 'End previous secret now' }));
    expect(server.calls.some((c) => c.method === 'POST' && c.url.endsWith('/ep-2/clear-previous-secret'))).toBe(true);
  });

  it('deletes only after a confirmation that names the consequence', async () => {
    const user = userEvent.setup();
    await renderList();
    await user.click(await screen.findByRole('button', { name: 'Delete' }));

    expect(screen.getByText(/Senders using this endpoint will stop being accepted/)).toBeTruthy();
    expect(server.calls.some((c) => c.method === 'DELETE')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(server.calls.some((c) => c.method === 'DELETE')).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(server.calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/ep-1'))).toBe(true));
    await waitFor(() => expect(screen.getByText('No inbound webhook endpoints yet')).toBeTruthy());
  });

  it('surfaces the server message when a rotate fails', async () => {
    const user = userEvent.setup();
    await renderList();
    await user.click(await screen.findByRole('button', { name: 'Rotate secret' }));
    server.failWith = 'Inbound webhook endpoint not found';
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Rotate' }));

    await waitFor(() => expect(screen.getByText('Inbound webhook endpoint not found')).toBeTruthy());
    expect(screen.queryByTestId('issued-secret')).toBeNull();
  });

  describe('rotate with a generated secret', () => {
    it('opens the dialog (Generate default), shows the secret panel once, and dismiss removes it', async () => {
      const user = userEvent.setup();
      const { queryClient } = await renderList();
      await user.click(await screen.findByRole('button', { name: 'Rotate secret' }));
      const dialog = within(await screen.findByRole('alertdialog'));
      expect((dialog.getByLabelText('Generate') as HTMLInputElement).checked).toBe(true);
      await user.click(dialog.getByRole('button', { name: 'Rotate' }));

      await waitFor(() => expect(screen.getByTestId('issued-secret').textContent).toBe('whsec_rotated'));
      expect(rotatePosts()[0]?.body).toEqual({});
      expect(screen.getByText(/shown only once and cannot be shown again/)).toBeTruthy();
      await waitFor(() => expect(screen.getByRole('button', { name: 'End previous secret now' })).toBeTruthy());
      expect(findSecretHolders(queryClient, 'whsec_rotated')).toEqual(['DOM text']);

      await user.click(screen.getByRole('button', { name: 'I have saved the secret' }));
      await waitForAbsent(() => screen.queryByTestId('issued-secret'));
      expect(findSecretHolders(queryClient, 'whsec_rotated')).toEqual([]);
    });
  });

  describe('rotate with an entered secret', () => {
    async function openEnterDialog(user: ReturnType<typeof userEvent.setup>) {
      await user.click(await screen.findByRole('button', { name: 'Rotate secret' }));
      const dialog = within(await screen.findByRole('alertdialog'));
      await user.click(dialog.getByLabelText('Enter my own'));
      const input = dialog.getByLabelText('Secret') as HTMLInputElement;
      expect(input.type).toBe('password');
      expect(input.autocomplete).toBe('off');
      return { dialog, input };
    }

    it('sends the entered secret, shows no panel, and leaves it in no cache and not in the DOM', async () => {
      const user = userEvent.setup();
      const { queryClient } = await renderList();
      const { dialog, input } = await openEnterDialog(user);
      fireEvent.change(input, { target: { value: ENTERED } });
      expect((dialog.getByRole('button', { name: 'Rotate' }) as HTMLButtonElement).disabled).toBe(false);

      await user.click(dialog.getByRole('button', { name: 'Rotate' }));

      await waitFor(() => expect(rotatePosts()).toHaveLength(1));
      expect(rotatePosts()[0]?.body).toEqual({ secret: ENTERED });
      await waitForAbsent(() => screen.queryByRole('alertdialog'));
      await waitFor(() => expect(screen.getByRole('button', { name: 'End previous secret now' })).toBeTruthy());
      expect(screen.queryByTestId('issued-secret')).toBeNull();
      expect(findSecretHolders(queryClient, ENTERED)).toEqual([]);
    });

    it('holds the entered secret in no mutation variable or data while the request is pending', async () => {
      let release!: () => void;
      server.rotateGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const user = userEvent.setup();
      const { queryClient } = await renderList();
      const { dialog, input } = await openEnterDialog(user);
      fireEvent.change(input, { target: { value: ENTERED } });
      await user.click(dialog.getByRole('button', { name: 'Rotate' }));
      await waitFor(() => expect(rotatePosts()).toHaveLength(1));

      expect(queryClient.getMutationCache().getAll().length).toBeGreaterThan(0);
      expect(findSecretHolders(queryClient, ENTERED)).toEqual([]);

      release();
      await waitFor(() => expect(queryClient.getMutationCache().getAll()).toHaveLength(0));
      expect(findSecretHolders(queryClient, ENTERED)).toEqual([]);
    });

    it('refuses an invalid secret with a value-free message and keeps Rotate disabled', async () => {
      const user = userEvent.setup();
      await renderList();
      const { dialog, input } = await openEnterDialog(user);
      expect((dialog.getByRole('button', { name: 'Rotate' }) as HTMLButtonElement).disabled).toBe(true);

      fireEvent.change(input, { target: { value: 'whsec_NOT-BASE64!!' } });

      expect(dialog.getByText('Secret must be "whsec_" followed by base64')).toBeTruthy();
      expect(document.body.textContent).not.toContain('NOT-BASE64');
      expect((dialog.getByRole('button', { name: 'Rotate' }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('drops the entered secret when the dialog is cancelled', async () => {
      const user = userEvent.setup();
      await renderList();
      const { dialog, input } = await openEnterDialog(user);
      fireEvent.change(input, { target: { value: ENTERED } });

      await user.click(dialog.getByRole('button', { name: 'Cancel' }));
      await waitForAbsent(() => screen.queryByRole('alertdialog'));
      await user.click(screen.getByRole('button', { name: 'Rotate secret' }));
      const reopened = within(await screen.findByRole('alertdialog'));

      expect((reopened.getByLabelText('Generate') as HTMLInputElement).checked).toBe(true);
      expect(reopened.queryByLabelText('Secret')).toBeNull();
      expect(rotatePosts()).toHaveLength(0);
    });
  });

  describe('one issued secret at a time', () => {
    async function renderTwoEndpoints() {
      server.endpoints = [makeEndpoint(), makeEndpoint({ id: 'ep-2', label: 'Other' })];
      const user = userEvent.setup();
      await renderList();
      await waitFor(() => expect(rotateButtons()).toHaveLength(2));
      return user;
    }

    async function rotateFirst(user: ReturnType<typeof userEvent.setup>) {
      await user.click(rotateButtons()[0]);
      await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Rotate' }));
    }

    it('(a) while a secret panel is displayed every Rotate is disabled and other actions stay available; dismissing re-enables', async () => {
      const user = await renderTwoEndpoints();
      expect(rotateButtons().every((b) => !b.disabled)).toBe(true);

      await rotateFirst(user);
      await waitFor(() => expect(screen.getByTestId('issued-secret').textContent).toBe('whsec_rotated'));

      expect(rotateButtons().every((b) => b.disabled)).toBe(true);
      expect((screen.getAllByRole('link', { name: 'Edit' })[0] as HTMLElement).getAttribute('aria-disabled')).toBeNull();
      expect((screen.getAllByRole('button', { name: 'Delete' })[0] as HTMLButtonElement).disabled).toBe(false);

      await user.click(screen.getByRole('button', { name: 'I have saved the secret' }));
      await waitFor(() => expect(rotateButtons().every((b) => !b.disabled)).toBe(true));
    });

    it('(b) while a rotate request is pending every Rotate is disabled and only one secret is shown', async () => {
      let release!: () => void;
      server.rotateGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const user = await renderTwoEndpoints();

      await rotateFirst(user);
      await waitFor(() => expect(rotatePosts()).toHaveLength(1));

      expect(rotateButtons().every((b) => b.disabled)).toBe(true);
      expect((screen.getAllByRole('button', { name: 'Delete' })[0] as HTMLButtonElement).disabled).toBe(false);
      expect(screen.queryAllByTestId('issued-secret')).toHaveLength(0);

      release();
      await waitFor(() => expect(screen.getByTestId('issued-secret').textContent).toBe('whsec_rotated'));
      expect(screen.getAllByTestId('issued-secret')).toHaveLength(1);
    });

    it('(c) clicking a disabled Rotate sends no second request and opens no dialog', async () => {
      const user = await renderTwoEndpoints();
      await rotateFirst(user);
      await waitFor(() => expect(screen.getByTestId('issued-secret').textContent).toBe('whsec_rotated'));
      expect(rotatePosts()).toHaveLength(1);

      await user.click(rotateButtons()[1]);
      fireEvent.click(rotateButtons()[1]);

      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(rotatePosts()).toHaveLength(1);
      expect(screen.getByTestId('issued-secret').textContent).toBe('whsec_rotated');
    });
  });
});
