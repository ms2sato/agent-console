// NOTE: These tests inject endpoint wire fields through a fake server's JSON
// bodies. The client's api layer DOES parse them with the shared valibot
// schemas, but the real server serializer is not exercised. Schema-level wire
// validation of the server side lives in the server route tests and
// packages/integration. Adding a new derived field requires updating BOTH places.
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import { Suspense } from 'react';
import { screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { EditInboundWebhookView } from '../edit';
import { renderWithRouter } from '../../../../../../../test/renderWithRouter';
import { installFakeServer, makeEndpoint } from '../../../../../../../test/inbound-webhooks-fake-server';

const server = installFakeServer();
afterAll(() => server.restore());
beforeEach(() => {
  server.reset();
  server.mockFetch.mockClear();
});
afterEach(cleanup);

const LIST_PATH = '/settings/repositories/repo-1/inbound-webhooks';

function renderEdit(endpointId = 'ep-1') {
  return renderWithRouter(
    <Suspense fallback={<div>Loading...</div>}>
      <EditInboundWebhookView repositoryId="repo-1" endpointId={endpointId} />
    </Suspense>,
  );
}

const patches = () => server.calls.filter((c) => c.method === 'PATCH');

describe('EditInboundWebhookView', () => {
  it('loads the endpoint into the form, without a secret choice or repository picker', async () => {
    server.endpoints = [makeEndpoint({ instructionText: 'line one\nline two' })];
    await renderEdit();

    await waitFor(() => expect((screen.getByLabelText('Label') as HTMLInputElement).value).toBe('Slack alerts'));
    expect((screen.getByLabelText('Instruction text') as HTMLTextAreaElement).value).toBe('line one\nline two');
    expect(screen.queryByLabelText('Generate')).toBeNull();
    expect(screen.queryByLabelText('Secret')).toBeNull();
    expect(screen.queryByLabelText('Repository')).toBeNull();
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
  });

  it('saves a multi-line instruction byte for byte and returns to the list', async () => {
    const user = userEvent.setup();
    const { router } = await renderEdit();
    await waitFor(() => expect((screen.getByLabelText('Label') as HTMLInputElement).value).toBe('Slack alerts'));
    const text = 'Alpha\nBeta\r\nGamma\n';
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: '  Renamed ' } });
    fireEvent.change(screen.getByLabelText('Instruction text'), { target: { value: text } });

    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]?.body).toEqual({ label: 'Renamed', instructionText: text });
    await waitFor(() => expect(router.state.location.pathname.replace(/\/$/, '')).toBe(LIST_PATH));
  });

  it('refuses a blank instruction, an empty label and 4001 characters; accepts 4000', async () => {
    await renderEdit();
    await waitFor(() => expect((screen.getByLabelText('Label') as HTMLInputElement).value).toBe('Slack alerts'));
    const save = () => screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    const instruction = screen.getByLabelText('Instruction text');

    fireEvent.change(instruction, { target: { value: '  \n ' } });
    expect(save().disabled).toBe(true);
    fireEvent.change(instruction, { target: { value: 'a'.repeat(4000) } });
    expect(save().disabled).toBe(false);
    fireEvent.change(instruction, { target: { value: 'a'.repeat(4001) } });
    expect(save().disabled).toBe(true);
    fireEvent.change(instruction, { target: { value: 'ok' } });
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: '' } });
    expect(save().disabled).toBe(true);
  });

  it('surfaces the server error and stays on the page', async () => {
    server.failWith = 'Instruction text is required';
    const user = userEvent.setup();
    const { router } = await renderEdit();
    await waitFor(() => expect((screen.getByLabelText('Label') as HTMLInputElement).value).toBe('Slack alerts'));
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Changed' } });

    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.getByText('Instruction text is required')).toBeTruthy());
    expect(router.state.location.pathname).toBe('/');
    expect((screen.getByLabelText('Label') as HTMLInputElement).value).toBe('Changed');
  });

  it('shows an error state with Retry when the endpoint does not load', async () => {
    await renderEdit('missing');
    await waitFor(() => expect(screen.getByText('Failed to load inbound webhook endpoint')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });
});
