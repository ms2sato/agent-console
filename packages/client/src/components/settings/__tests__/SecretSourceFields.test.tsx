import { describe, it, expect, mock, afterEach } from 'bun:test';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SecretSourceFields } from '../SecretSourceFields';
import type { SecretSourceChoice } from '../../../lib/inbound-webhook-form';

afterEach(cleanup);

const VALID = `whsec_${Buffer.alloc(24, 6).toString('base64')}`;

function setup(source: SecretSourceChoice = 'generate', secret = '', disabled = false) {
  const onSourceChange = mock((_s: SecretSourceChoice) => {});
  const onSecretChange = mock((_s: string) => {});
  const view = render(
    <SecretSourceFields
      source={source}
      secret={secret}
      disabled={disabled}
      onSourceChange={onSourceChange}
      onSecretChange={onSecretChange}
    />,
  );
  const rerender = (next: { source: SecretSourceChoice; secret: string }) =>
    view.rerender(
      <SecretSourceFields {...next} onSourceChange={onSourceChange} onSecretChange={onSecretChange} />,
    );
  return { onSourceChange, onSecretChange, rerender };
}

describe('SecretSourceFields', () => {
  it('with Generate selected shows no secret input', () => {
    setup('generate');
    expect((screen.getByLabelText('Generate') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Enter my own') as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByLabelText('Secret')).toBeNull();
  });

  it('with Enter my own selected shows a password input that autofill leaves alone', () => {
    setup('enter');
    const input = screen.getByLabelText('Secret') as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.autocomplete).toBe('off');
    expect((screen.getByLabelText('Enter my own') as HTMLInputElement).checked).toBe(true);
  });

  it('reports the chosen source and typed secret to the parent, which owns the state', async () => {
    const { onSourceChange } = setup('generate');
    await userEvent.setup().click(screen.getByLabelText('Enter my own'));
    expect(onSourceChange).toHaveBeenCalledWith('enter');

    cleanup();
    const second = setup('enter');
    fireEvent.change(screen.getByLabelText('Secret'), { target: { value: VALID } });
    expect(second.onSecretChange).toHaveBeenCalledWith(VALID);
  });

  it('switching back to Generate hides the input (the parent clears the value through onSourceChange)', async () => {
    const { onSourceChange, rerender } = setup('enter', VALID);
    expect((screen.getByLabelText('Secret') as HTMLInputElement).value).toBe(VALID);

    await userEvent.setup().click(screen.getByLabelText('Generate'));
    expect(onSourceChange).toHaveBeenCalledWith('generate');

    // The component itself does not clear: it renders what the parent passes.
    rerender({ source: 'generate', secret: '' });
    expect(screen.queryByLabelText('Secret')).toBeNull();
    expect(document.body.textContent).not.toContain(VALID);
  });

  it('shows a rule-only error for an invalid entered value and never echoes the value', () => {
    setup('enter', 'whsec_ENTEREDVALUE!!');
    expect(screen.getByText('Secret must be "whsec_" followed by base64')).toBeTruthy();
    expect(document.body.textContent).not.toContain('ENTEREDVALUE');
  });

  it('shows the byte-length rule for a well-formed but too short value, still value-free', () => {
    const short = `whsec_${Buffer.alloc(23, 6).toString('base64')}`;
    setup('enter', short);
    expect(screen.getByText('Secret must decode to 24 to 64 bytes')).toBeTruthy();
    expect(document.body.textContent).not.toContain(short);
  });

  it('boundary: an empty entered value shows no error, and a valid one shows none either', () => {
    setup('enter', '');
    expect(screen.queryByText(/^Secret must/)).toBeNull();
    cleanup();
    setup('enter', VALID);
    expect(screen.queryByText(/^Secret must/)).toBeNull();
  });

  it('shows no error for a typed value while Generate is selected', () => {
    setup('generate', 'whsec_BAD!!');
    expect(screen.queryByText(/^Secret must/)).toBeNull();
  });

  it('disables both radios and the secret input through the fieldset when disabled', () => {
    setup('enter', '', true);
    expect(document.querySelector('fieldset')?.disabled).toBe(true);
  });
});
