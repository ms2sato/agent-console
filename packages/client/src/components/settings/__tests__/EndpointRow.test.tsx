// NOTE: This test injects schema-derived fields (hasPreviousSecret,
// previousSecretExpiresAt) directly as props and DOES NOT exercise the
// WebSocket/valibot parse path. Schema-level wire validation lives in the
// api tests and packages/server route tests.
import { describe, it, expect, mock, afterEach } from 'bun:test';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { InboundWebhookEndpoint } from '@agent-console/shared';
import { EndpointRow } from '../EndpointRow';

afterEach(cleanup);

function makeEndpoint(overrides: Partial<InboundWebhookEndpoint> = {}): InboundWebhookEndpoint {
  return {
    id: 'ep-1',
    label: 'Alerts',
    repositoryId: 'repo-1',
    instructionText: 'Triage it',
    hasPreviousSecret: false,
    previousSecretExpiresAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function setup(endpoint = makeEndpoint(), busy = false, onSave: (id: string, c: { label: string; instructionText: string }) => Promise<void> = async () => {}) {
  const handlers = {
    onSave: mock(onSave),
    onRotate: mock((_e: InboundWebhookEndpoint) => {}),
    onClearPrevious: mock((_e: InboundWebhookEndpoint) => {}),
    onDelete: mock((_e: InboundWebhookEndpoint) => {}),
  };
  render(<EndpointRow endpoint={endpoint} repositoryName="alpha" busy={busy} {...handlers} />);
  return handlers;
}

const saveButton = () => screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;

describe('EndpointRow', () => {
  it('renders label, repository, instruction and the path hint', () => {
    setup();
    expect(screen.getByText('Alerts')).toBeTruthy();
    expect(screen.getByText('Repository: alpha')).toBeTruthy();
    expect(screen.getByText('Instruction: Triage it')).toBeTruthy();
    expect(screen.getByText('/webhooks/in/ep-1')).toBeTruthy();
  });

  it('wires Rotate and Delete to their callbacks with the endpoint', async () => {
    const user = userEvent.setup();
    const endpoint = makeEndpoint();
    const h = setup(endpoint);
    await user.click(screen.getByRole('button', { name: 'Rotate secret' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(h.onRotate).toHaveBeenCalledWith(endpoint);
    expect(h.onDelete).toHaveBeenCalledWith(endpoint);
  });

  it('shows the previous-secret controls only when hasPreviousSecret is true', async () => {
    const user = userEvent.setup();
    setup();
    expect(screen.queryByRole('button', { name: 'End previous secret now' })).toBeNull();
    expect(screen.queryByText(/Previous secret still valid until/)).toBeNull();
    cleanup();

    const endpoint = makeEndpoint({ hasPreviousSecret: true, previousSecretExpiresAt: '2099-01-02T00:00:00.000Z' });
    const h = setup(endpoint);
    expect(screen.getByText(/Previous secret still valid until/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'End previous secret now' }));
    expect(h.onClearPrevious).toHaveBeenCalledWith(endpoint);
  });

  it('disables every action while busy', () => {
    setup(makeEndpoint({ hasPreviousSecret: true, previousSecretExpiresAt: '2099-01-02T00:00:00.000Z' }), true);
    for (const name of ['Edit', 'Rotate secret', 'End previous secret now', 'Delete']) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('edit mode shows the repository as read-only and Cancel restores the view without saving', async () => {
    const user = userEvent.setup();
    const h = setup();
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByText(/Repository: alpha \(fixed after creation\)/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Changed' } });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.getByText('Alerts')).toBeTruthy();
    expect(h.onSave).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    expect((screen.getByLabelText('Label') as HTMLInputElement).value).toBe('Alerts');
  });

  it('Save sends trimmed label and instruction and leaves edit mode', async () => {
    const user = userEvent.setup();
    const h = setup();
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: '  Renamed ' } });
    fireEvent.change(screen.getByLabelText('Instruction text'), { target: { value: 'New text' } });

    await user.click(saveButton());

    await waitFor(() => expect(h.onSave).toHaveBeenCalledWith('ep-1', { label: 'Renamed', instructionText: 'New text' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save' })).toBeNull());
  });

  it('stays in edit mode when Save rejects', async () => {
    const user = userEvent.setup();
    const h = setup(makeEndpoint(), false, async () => {
      throw new Error('nope');
    });
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.click(saveButton());
    await waitFor(() => expect(h.onSave).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
  });

  it('refuses empty label and 101 character label, accepts 100', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: '' } });
    expect(screen.getByText('Label is required')).toBeTruthy();
    expect(saveButton().disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'a'.repeat(101) } });
    expect(saveButton().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'a'.repeat(100) } });
    expect(saveButton().disabled).toBe(false);
  });

  it('accepts a 300 character instruction and refuses 301 or blank', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const input = screen.getByLabelText('Instruction text');

    fireEvent.change(input, { target: { value: 'a'.repeat(300) } });
    expect(saveButton().disabled).toBe(false);
    fireEvent.change(input, { target: { value: 'a'.repeat(301) } });
    expect(screen.getByText('Instruction text must be at most 300 characters')).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
    fireEvent.change(input, { target: { value: '  ' } });
    expect(screen.getByText('Instruction text is required')).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
  });
});
