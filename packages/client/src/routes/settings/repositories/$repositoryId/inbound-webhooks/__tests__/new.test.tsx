// NOTE: These tests inject wire fields (secretSource, secret) through a fake
// server's JSON bodies. The client's api layer DOES parse them with the shared
// valibot schemas, but the real server serializer is not exercised.
// Schema-level wire validation of the server side lives in the server route
// tests and packages/integration. Adding a new derived field requires updating
// BOTH places.
import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import { Suspense } from 'react';
import { screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { NewInboundWebhookView } from '../new';
import { renderWithRouter } from '../../../../../../test/renderWithRouter';
import { waitForAbsent } from '../../../../../../test/waitForAbsent';
import { installFakeServer } from '../../../../../../test/inbound-webhooks-fake-server';
import { findSecretHolders } from '../../../../../../test/assert-no-secret';

const server = installFakeServer();
afterAll(() => server.restore());
beforeEach(() => {
  server.reset();
  server.endpoints = [];
  server.mockFetch.mockClear();
});
afterEach(cleanup);

const ENTERED = `whsec_${Buffer.alloc(32, 5).toString('base64')}`;
const LIST_PATH = '/settings/repositories/repo-1/inbound-webhooks';

function renderNew() {
  return renderWithRouter(
    <Suspense fallback={<div>Loading...</div>}>
      <NewInboundWebhookView repositoryId="repo-1" />
    </Suspense>,
  );
}

const createButton = () => screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement;
const posts = () => server.calls.filter((c) => c.method === 'POST');

async function fillForm(label = 'Alerts', instruction = 'Triage it') {
  await screen.findByLabelText('Label');
  fireEvent.change(screen.getByLabelText('Label'), { target: { value: label } });
  fireEvent.change(screen.getByLabelText('Instruction text'), { target: { value: instruction } });
}

describe('NewInboundWebhookView', () => {
  it('renders the form with Generate selected, no secret input, and the repository in the breadcrumb', async () => {
    await renderNew();
    await screen.findByLabelText('Label');

    expect(screen.getByText('my-repo')).toBeTruthy();
    expect((screen.getByLabelText('Generate') as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByLabelText('Secret')).toBeNull();
    expect(screen.getByLabelText('Instruction text').tagName).toBe('TEXTAREA');
    expect(createButton().disabled).toBe(true);
  });

  describe('generated secret', () => {
    it('replaces the form with the panel showing the receive URL and the secret, each with Copy, and a Done link', async () => {
      const writeText = mock((_t: string) => Promise.resolve());
      const user = userEvent.setup();
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      const { queryClient } = await renderNew();
      await fillForm();

      await user.click(createButton());

      await waitFor(() => expect(screen.getByTestId('issued-secret').textContent).toBe('whsec_generated'));
      expect(screen.queryByLabelText('Label')).toBeNull();
      expect(posts()[0]?.body).toEqual({ label: 'Alerts', instructionText: 'Triage it' });
      expect(screen.getByRole('link', { name: 'Done' }).getAttribute('href')).toBe(LIST_PATH);
      // Only the panel's own text holds the secret: no cache entry, no input.
      expect(findSecretHolders(queryClient, 'whsec_generated')).toEqual(['DOM text']);

      const url = within(await screen.findByTestId('receive-url'));
      await waitFor(() => expect(url.getByText('https://hooks.example.com/webhooks/in/ep-new')).toBeTruthy());
      await user.click(url.getByRole('button', { name: 'Copy' }));
      expect(writeText).toHaveBeenLastCalledWith('https://hooks.example.com/webhooks/in/ep-new');
      await user.click(within(screen.getByTestId('secret-block')).getByRole('button', { name: 'Copy' }));
      expect(writeText).toHaveBeenLastCalledWith('whsec_generated');
    });

    it('shows the path and the hint on the panel when the origin is unset, and Copy copies the path', async () => {
      server.internetOrigin = null;
      const writeText = mock((_t: string) => Promise.resolve());
      const user = userEvent.setup();
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      await renderNew();
      await fillForm();
      await user.click(createButton());

      const url = within(await screen.findByTestId('receive-url'));
      await waitFor(() =>
        expect(url.getByText('Set AGENT_CONSOLE_INTERNET_ORIGIN on the server to show the full URL')).toBeTruthy(),
      );
      expect(url.getByText('/webhooks/in/ep-new')).toBeTruthy();
      await user.click(url.getByRole('button', { name: 'Copy' }));
      expect(writeText).toHaveBeenLastCalledWith('/webhooks/in/ep-new');
    });
  });

  describe('entered secret', () => {
    async function chooseEnter(user: ReturnType<typeof userEvent.setup>) {
      await screen.findByLabelText('Label');
      await user.click(screen.getByLabelText('Enter my own'));
      const input = screen.getByLabelText('Secret') as HTMLInputElement;
      expect(input.type).toBe('password');
      expect(input.autocomplete).toBe('off');
      return input;
    }

    it('keeps Create disabled for an invalid secret and shows a value-free message', async () => {
      const user = userEvent.setup();
      await renderNew();
      const input = await chooseEnter(user);
      await fillForm();

      expect(createButton().disabled).toBe(true);
      fireEvent.change(input, { target: { value: 'whsec_SECRETISH!!' } });
      expect(screen.getByText('Secret must be "whsec_" followed by base64')).toBeTruthy();
      expect(document.body.textContent).not.toContain('SECRETISH');
      expect(createButton().disabled).toBe(true);

      fireEvent.change(input, { target: { value: ENTERED } });
      expect(createButton().disabled).toBe(false);
    });

    it('sends the secret, navigates to the list with no panel, and no cache, state or DOM keeps it', async () => {
      const user = userEvent.setup();
      const { queryClient, router } = await renderNew();
      const input = await chooseEnter(user);
      await fillForm();
      fireEvent.change(input, { target: { value: ENTERED } });

      await user.click(createButton());

      await waitFor(() => expect(posts()).toHaveLength(1));
      expect(posts()[0]?.body).toEqual({ label: 'Alerts', instructionText: 'Triage it', secret: ENTERED });
      await waitFor(() => expect(router.state.location.pathname.replace(/\/$/, '')).toBe(LIST_PATH));
      expect(router.state.location.search).toEqual({});
      expect(router.state.location.state).not.toHaveProperty('secret');
      expect(JSON.stringify(router.state.location)).not.toContain(ENTERED);
      expect(screen.queryByTestId('issued-secret')).toBeNull();
      await waitFor(() => expect(queryClient.getMutationCache().getAll()).toHaveLength(0));
      expect(findSecretHolders(queryClient, ENTERED)).toEqual([]);
    });

    it('clears the field at submit and holds the secret in no mutation variable or data while the request is pending', async () => {
      let release!: () => void;
      server.createGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const user = userEvent.setup();
      const { queryClient } = await renderNew();
      const input = await chooseEnter(user);
      await fillForm();
      fireEvent.change(input, { target: { value: ENTERED } });

      await user.click(createButton());
      await waitFor(() => expect(posts()).toHaveLength(1));

      expect(queryClient.getMutationCache().getAll().length).toBeGreaterThan(0);
      expect(findSecretHolders(queryClient, ENTERED)).toEqual([]);

      release();
      await waitFor(() => expect(queryClient.getMutationCache().getAll()).toHaveLength(0));
      expect(findSecretHolders(queryClient, ENTERED)).toEqual([]);
    });

    it('does not carry the entered secret over when switching back to Generate', async () => {
      const user = userEvent.setup();
      await renderNew();
      const input = await chooseEnter(user);
      fireEvent.change(input, { target: { value: ENTERED } });

      await user.click(screen.getByLabelText('Generate'));
      await user.click(screen.getByLabelText('Enter my own'));

      expect((screen.getByLabelText('Secret') as HTMLInputElement).value).toBe('');
    });
  });

  describe('instruction text', () => {
    it('round-trips a multi-line instruction exactly (LF, CRLF, trailing line break)', async () => {
      const user = userEvent.setup();
      await renderNew();
      const text = 'First line\nSecond line\r\nThird\n';
      await fillForm('Multi', text);

      await user.click(createButton());

      await waitFor(() => expect(posts()).toHaveLength(1));
      expect((posts()[0]?.body as { instructionText: string }).instructionText).toBe(text);
    });

    it('accepts 4000 characters and refuses 4001 with a message', async () => {
      await renderNew();
      await fillForm('L', 'a'.repeat(4000));
      expect(createButton().disabled).toBe(false);
      expect(screen.queryByText(/must be at most 4000/)).toBeNull();

      fireEvent.change(screen.getByLabelText('Instruction text'), { target: { value: 'a'.repeat(4001) } });
      expect(screen.getByText('Instruction text must be at most 4000 characters')).toBeTruthy();
      expect(createButton().disabled).toBe(true);
    });

    it('refuses blank and line-break-only instruction text', async () => {
      await renderNew();
      await fillForm('L', '\n \n');
      expect(screen.getByText('Instruction text is required')).toBeTruthy();
      expect(createButton().disabled).toBe(true);
    });

    it('refuses an empty label and a 101 character label, accepts 100', async () => {
      await renderNew();
      await fillForm('', 'ok');
      expect(createButton().disabled).toBe(true);
      fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'a'.repeat(100) } });
      expect(createButton().disabled).toBe(false);
      fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'a'.repeat(101) } });
      expect(createButton().disabled).toBe(true);
    });
  });

  it('surfaces the server error, keeps the input and shows no panel', async () => {
    server.failWith = 'Repository not found';
    const user = userEvent.setup();
    await renderNew();
    await fillForm('Alerts', 'Triage it');

    await user.click(createButton());

    await waitFor(() => expect(screen.getByText('Repository not found')).toBeTruthy());
    expect((screen.getByLabelText('Label') as HTMLInputElement).value).toBe('Alerts');
    expect((screen.getByLabelText('Instruction text') as HTMLTextAreaElement).value).toBe('Triage it');
    await waitForAbsent(() => screen.queryByTestId('issued-secret'));
  });
});
