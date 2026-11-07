// NOTE: This test injects schema-derived fields (hasPreviousSecret,
// previousSecretExpiresAt) through a fake server's JSON bodies, which the
// client's api layer DOES parse with the shared valibot schemas, but it does
// not exercise the real server serializer. Schema-level wire validation of the
// server side lives in packages/server route tests and packages/integration.
// Adding a new derived field requires updating BOTH places.
import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import { screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { waitForAbsent } from '../../../test/waitForAbsent';

import type { InboundWebhookEndpoint } from '@agent-console/shared';
import { InboundWebhooksPage } from '../inbound-webhooks';
import { renderWithRouter } from '../../../test/renderWithRouter';
import { inboundWebhookEndpointKeys } from '../../../lib/query-keys';

const originalFetch = globalThis.fetch;
const mockFetch = mock((_input: RequestInfo | URL, _init?: RequestInit) => Promise.resolve(new Response()));
globalThis.fetch = Object.assign(mockFetch, { preconnect: () => {} }) as typeof fetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

function requestUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : String(input);
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  return (input instanceof Request ? input.method : init?.method ?? 'GET').toUpperCase();
}

const repository = {
  id: 'repo-1',
  name: 'my-repo',
  path: '/repos/my-repo',
  createdAt: '2026-01-01T00:00:00Z',
  orchestratorSessionIds: [],
  clonedSourceRepoPath: null,
};

function makeEndpoint(overrides: Partial<InboundWebhookEndpoint> = {}): InboundWebhookEndpoint {
  return {
    id: 'ep-1',
    label: 'Slack alerts',
    repositoryId: 'repo-1',
    instructionText: 'Triage the message',
    hasPreviousSecret: false,
    previousSecretExpiresAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

let endpoints: InboundWebhookEndpoint[] = [];
let listStatus = 200;
let calls: Array<{ method: string; url: string; body: unknown }> = [];

async function readBody(input: RequestInfo | URL, init?: RequestInit): Promise<unknown> {
  const raw = input instanceof Request ? await input.clone().text() : (init?.body as string | undefined);
  return raw ? JSON.parse(raw) : undefined;
}

beforeEach(() => {
  endpoints = [makeEndpoint()];
  listStatus = 200;
  calls = [];
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    const method = requestMethod(input, init);
    if (url.includes('/api/repositories')) return jsonResponse({ repositories: [repository] });
    if (!url.includes('/api/inbound-webhook-endpoints')) return jsonResponse({});
    const body = await readBody(input, init);
    calls.push({ method, url, body });

    if (method === 'GET') {
      if (listStatus !== 200) return jsonResponse({ error: 'boom' }, listStatus);
      return jsonResponse({ endpoints });
    }
    if (method === 'POST' && url.endsWith('/api/inbound-webhook-endpoints')) {
      const created = makeEndpoint({ id: 'ep-new', label: (body as { label: string }).label });
      endpoints = [...endpoints, created];
      return jsonResponse({ endpoint: created, secret: 'whsec_created' }, 201);
    }
    if (method === 'POST' && url.endsWith('/rotate-secret')) {
      const rotatedId = url.split('/').slice(-2)[0];
      endpoints = endpoints.map((e) =>
        e.id === rotatedId
          ? { ...e, hasPreviousSecret: true, previousSecretExpiresAt: '2099-01-02T00:00:00.000Z' }
          : e,
      );
      const rotated = endpoints.find((e) => e.id === rotatedId);
      return jsonResponse({ endpoint: rotated, secret: rotatedId === 'ep-1' ? 'whsec_rotated' : `whsec_rotated_${rotatedId}` });
    }
    if (method === 'POST' && url.endsWith('/clear-previous-secret')) {
      endpoints = endpoints.map((e) => ({ ...e, hasPreviousSecret: false, previousSecretExpiresAt: null }));
      return jsonResponse({ endpoint: endpoints[0] });
    }
    if (method === 'PATCH') {
      endpoints = endpoints.map((e) => ({ ...e, ...(body as object) }));
      return jsonResponse({ endpoint: endpoints[0] });
    }
    if (method === 'DELETE') {
      endpoints = [];
      return jsonResponse({ success: true });
    }
    return jsonResponse({}, 404);
  });
});

afterEach(() => {
  cleanup();
});

async function fillCreateForm(user: ReturnType<typeof userEvent.setup>, label: string, instruction: string) {
  await waitFor(() => expect(screen.getByRole('option', { name: 'my-repo' })).toBeTruthy());
  await user.selectOptions(screen.getByLabelText('Repository'), 'repo-1');
  await user.type(screen.getByLabelText('Label'), label);
  fireEvent.change(screen.getByLabelText(/Instruction text/), { target: { value: instruction } });
}

describe('InboundWebhooksPage', () => {
  it('lists endpoints with resolved repository name, instruction, path hint and the in-development note', async () => {
    await renderWithRouter(<InboundWebhooksPage />);

    await waitFor(() => expect(screen.getByText('Slack alerts')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('Repository: my-repo')).toBeTruthy());
    expect(screen.getByText('Instruction: Triage the message')).toBeTruthy();
    expect(screen.getByText('/webhooks/in/ep-1')).toBeTruthy();
    expect(screen.getByText(/Receiving is not active yet \(in development\)/)).toBeTruthy();
    expect(screen.queryByText(/whsec_/)).toBeNull();
  });

  it('shows an empty state', async () => {
    endpoints = [];
    await renderWithRouter(<InboundWebhooksPage />);
    await waitFor(() => expect(screen.getByText('No inbound webhook endpoints yet')).toBeTruthy());
  });

  it('shows an error state with Retry', async () => {
    listStatus = 500;
    await renderWithRouter(<InboundWebhooksPage />);
    await waitFor(() => expect(screen.getByText('Failed to load inbound webhook endpoints')).toBeTruthy());
    listStatus = 200;
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText('Slack alerts')).toBeTruthy());
  });

  it('create shows the secret once, never in the list cache, and dismiss removes it', async () => {
    const user = userEvent.setup();
    const { queryClient } = await renderWithRouter(<InboundWebhooksPage />);
    await fillCreateForm(user, 'New one', 'Do the thing');

    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(screen.getByTestId('issued-secret').textContent).toBe('whsec_created'));
    expect(screen.getByText(/shown only once and cannot be shown again/)).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      label: 'New one',
      repositoryId: 'repo-1',
      instructionText: 'Do the thing',
    });

    // The list refetched and the secret is in no query cache entry.
    await waitFor(() => expect(screen.getByText('New one')).toBeTruthy());
    expect(JSON.stringify(queryClient.getQueryData(inboundWebhookEndpointKeys.all()))).not.toContain('whsec_');
    expect(queryClient.getMutationCache().getAll().some((m) => JSON.stringify(m.state.data ?? null).includes('whsec_'))).toBe(false);

    await user.click(screen.getByRole('button', { name: 'I have saved the secret' }));
    expect(screen.queryByTestId('issued-secret')).toBeNull();
    expect(screen.queryByText(/whsec_created/)).toBeNull();
  });

  it('Copy writes the secret to the clipboard', async () => {
    const writeText = mock((_text: string) => Promise.resolve());
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await renderWithRouter(<InboundWebhooksPage />);
    await fillCreateForm(user, 'New one', 'Do the thing');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(screen.getByTestId('issued-secret')).toBeTruthy());

    await user.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy());
    expect(writeText).toHaveBeenCalledWith('whsec_created');
  });

  it('Copy failure shows a manual-copy hint instead of throwing', async () => {
    const writeText = mock((_text: string) => Promise.reject(new Error('denied')));
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await renderWithRouter(<InboundWebhooksPage />);
    await fillCreateForm(user, 'New one', 'Do the thing');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(screen.getByTestId('issued-secret')).toBeTruthy());

    await user.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(screen.getByText(/Could not copy automatically/)).toBeTruthy());
  });

  it('rotate shows the new secret once and the previous-secret controls appear', async () => {
    const user = userEvent.setup();
    await renderWithRouter(<InboundWebhooksPage />);
    await waitFor(() => expect(screen.getByText('Slack alerts')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'End previous secret now' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Rotate secret' }));

    await waitFor(() => expect(screen.getByTestId('issued-secret').textContent).toBe('whsec_rotated'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'End previous secret now' })).toBeTruthy());
    expect(screen.getByText(/Previous secret still valid until/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'I have saved the secret' }));
    expect(screen.queryByText(/whsec_rotated/)).toBeNull();
  });

  it('a second issued secret replaces the first panel without inheriting its "Copied" state', async () => {
    endpoints = [makeEndpoint(), makeEndpoint({ id: 'ep-2', label: 'Other' })];
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: mock((_t: string) => Promise.resolve()) }, configurable: true });
    await renderWithRouter(<InboundWebhooksPage />);
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Rotate secret' })).toHaveLength(2));

    await user.click(screen.getAllByRole('button', { name: 'Rotate secret' })[0]);
    await waitFor(() => expect(screen.getByTestId('issued-secret').textContent).toBe('whsec_rotated'));
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy());

    // Rotate the other endpoint WITHOUT dismissing the first panel.
    await user.click(screen.getAllByRole('button', { name: 'Rotate secret' })[1]);

    await waitFor(() => expect(screen.getByTestId('issued-secret').textContent).toBe('whsec_rotated_ep-2'));
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull();
  });

  it('End previous secret now calls the endpoint and hides the control', async () => {
    endpoints = [makeEndpoint({ hasPreviousSecret: true, previousSecretExpiresAt: '2099-01-02T00:00:00.000Z' })];
    const user = userEvent.setup();
    await renderWithRouter(<InboundWebhooksPage />);

    await user.click(await screen.findByRole('button', { name: 'End previous secret now' }));

    await waitForAbsent(() => screen.queryByRole('button', { name: 'End previous secret now' }));
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/ep-1/clear-previous-secret'))).toBe(true);
    expect(screen.queryByText(/Previous secret still valid until/)).toBeNull();
  });

  it('deletes only after confirmation', async () => {
    const user = userEvent.setup();
    await renderWithRouter(<InboundWebhooksPage />);
    await user.click(await screen.findByRole('button', { name: 'Delete' }));

    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('alertdialog');
    const confirm = Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === 'Delete')!;
    await user.click(confirm);

    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/ep-1'))).toBe(true));
    await waitFor(() => expect(screen.getByText('No inbound webhook endpoints yet')).toBeTruthy());
  });

  it('edits label and instruction text, repository is read-only', async () => {
    const user = userEvent.setup();
    await renderWithRouter(<InboundWebhooksPage />);
    await user.click(await screen.findByRole('button', { name: 'Edit' }));

    expect(screen.getByText(/\(fixed after creation\)/)).toBeTruthy();
    const row = within(screen.getByTestId('endpoint-ep-1'));
    await user.clear(row.getByLabelText('Label'));
    await user.type(row.getByLabelText('Label'), 'Renamed');
    await user.click(row.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({
        label: 'Renamed',
        instructionText: 'Triage the message',
      }),
    );
  });

  it('surfaces the server error message when create fails', async () => {
    const user = userEvent.setup();
    await renderWithRouter(<InboundWebhooksPage />);
    await fillCreateForm(user, 'New one', 'Do the thing');
    const base = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation(async (input, init) => {
      if (requestMethod(input, init) === 'POST') return jsonResponse({ error: 'Repository not found' }, 404);
      return base(input, init);
    });

    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(screen.getByText('Repository not found')).toBeTruthy());
    expect(screen.queryByTestId('issued-secret')).toBeNull();
  });

  describe('instruction text validation', () => {
    it('never lets a line break reach the request: a text input strips it, and the validator refuses it anyway', async () => {
      const user = userEvent.setup();
      await renderWithRouter(<InboundWebhooksPage />);
      await fillCreateForm(user, 'L', 'line1\nline2');

      // The DOM sanitises a line break out of a single-line input's value, so the
      // "single line" message itself is pinned at the validator level
      // (lib/__tests__/inbound-webhook-form.test.ts).
      const input = screen.getByLabelText(/Instruction text/) as HTMLInputElement;
      expect(input.value).not.toMatch(/[\r\n]/);

      await user.click(screen.getByRole('button', { name: 'Create' }));
      await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
      const body = calls.find((c) => c.method === 'POST')?.body as { instructionText: string };
      expect(body.instructionText).not.toMatch(/[\r\n]/);
    });

    it('accepts exactly 300 characters and shows a message at 301', async () => {
      const user = userEvent.setup();
      await renderWithRouter(<InboundWebhooksPage />);
      await fillCreateForm(user, 'L', 'a'.repeat(300));
      expect(screen.queryByText(/at most 300 characters/)).toBeNull();
      expect((screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement).disabled).toBe(false);

      fireEvent.change(screen.getByLabelText(/Instruction text/), { target: { value: 'a'.repeat(301) } });
      expect(screen.getByText('Instruction text must be at most 300 characters')).toBeTruthy();
      expect((screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('keeps Create disabled for empty instruction text and for a blank label', async () => {
      const user = userEvent.setup();
      await renderWithRouter(<InboundWebhooksPage />);
      await fillCreateForm(user, '   ', '');
      expect((screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement).disabled).toBe(true);
    });
  });
});
