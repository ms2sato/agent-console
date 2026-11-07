import { describe, it, expect, mock, afterEach } from 'bun:test';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RotateSecretDialog } from '../RotateSecretDialog';
import { makeEndpoint } from '../../../test/inbound-webhooks-fake-server';
import type { TakeSecret } from '../hooks/useInboundWebhookEndpoints';

afterEach(cleanup);

const ENTERED = `whsec_${Buffer.alloc(40, 1).toString('base64')}`;

function setup() {
  const onRotate = mock((_e: unknown, _t?: TakeSecret) => {});
  const onCancel = mock(() => {});
  const endpoint = makeEndpoint();
  render(<RotateSecretDialog endpoint={endpoint} onCancel={onCancel} onRotate={onRotate} />);
  return { onRotate, onCancel, endpoint, dialog: within(screen.getByRole('alertdialog')) };
}

const rotateButton = () => screen.getByRole('button', { name: 'Rotate' }) as HTMLButtonElement;

describe('RotateSecretDialog', () => {
  it('defaults to Generate and rotates without a reader', async () => {
    const { onRotate, endpoint, dialog } = setup();
    expect((dialog.getByLabelText('Generate') as HTMLInputElement).checked).toBe(true);
    expect(dialog.queryByLabelText('Secret')).toBeNull();

    await userEvent.setup().click(rotateButton());

    expect(onRotate).toHaveBeenCalledTimes(1);
    expect(onRotate).toHaveBeenCalledWith(endpoint);
  });

  it('Enter my own: password field, Rotate disabled until valid, then a one-shot reader and a cleared field', async () => {
    const { onRotate, dialog } = setup();
    const user = userEvent.setup();
    await user.click(dialog.getByLabelText('Enter my own'));
    const input = dialog.getByLabelText('Secret') as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.autocomplete).toBe('off');
    expect(rotateButton().disabled).toBe(true);

    fireEvent.change(input, { target: { value: ENTERED } });
    expect(rotateButton().disabled).toBe(false);
    await user.click(rotateButton());

    const take = onRotate.mock.calls[0]![1] as TakeSecret;
    expect(JSON.stringify(onRotate.mock.calls[0])).not.toContain(ENTERED);
    expect(take()).toBe(ENTERED);
    expect(take()).toBeUndefined();
    expect(input.value).toBe('');
  });

  it('boundaries: 23 bytes refused, 24 and 64 accepted, 65 refused', async () => {
    const { dialog } = setup();
    await userEvent.setup().click(dialog.getByLabelText('Enter my own'));
    const input = dialog.getByLabelText('Secret');
    const secretOf = (n: number) => `whsec_${Buffer.alloc(n, 2).toString('base64')}`;
    for (const [bytes, ok] of [[23, false], [24, true], [64, true], [65, false]] as const) {
      fireEvent.change(input, { target: { value: secretOf(bytes) } });
      expect(rotateButton().disabled).toBe(!ok);
    }
  });

  it('shows a rule-only message and never the entered value', async () => {
    const { dialog } = setup();
    await userEvent.setup().click(dialog.getByLabelText('Enter my own'));
    fireEvent.change(dialog.getByLabelText('Secret'), { target: { value: 'whsec_TOPSECRETVALUE!' } });
    expect(dialog.getByText('Secret must be "whsec_" followed by base64')).toBeTruthy();
    expect(document.body.textContent).not.toContain('TOPSECRETVALUE');
  });

  it('Cancel calls onCancel and never rotates', async () => {
    const { onRotate, onCancel, dialog } = setup();
    await userEvent.setup().click(dialog.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
    expect(onRotate).not.toHaveBeenCalled();
  });
});
