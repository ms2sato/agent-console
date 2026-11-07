import { describe, it, expect, mock, afterEach } from 'bun:test';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EndpointForm, type EndpointFormPayload } from '../EndpointForm';

afterEach(cleanup);

const ENTERED = `whsec_${Buffer.alloc(24, 3).toString('base64')}`;

function setup(props: { mode?: 'create' | 'edit'; initial?: { label: string; instructionText: string }; isPending?: boolean; onSubmit?: (p: EndpointFormPayload) => Promise<void> } = {}) {
  const submit = mock(props.onSubmit ?? (async (_p: EndpointFormPayload) => {}));
  render(<EndpointForm mode={props.mode ?? 'create'} initial={props.initial} isPending={props.isPending ?? false} onSubmit={submit} />);
  return submit;
}

const submitButton = () => document.querySelector('button[type="submit"]') as HTMLButtonElement;

describe('EndpointForm', () => {
  it('create mode: textarea for the instruction, Generate default, no secret input', () => {
    setup();
    expect(screen.getByLabelText('Instruction text').tagName).toBe('TEXTAREA');
    expect((screen.getByLabelText('Generate') as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByLabelText('Secret')).toBeNull();
    expect(submitButton().textContent).toBe('Create');
    expect(submitButton().disabled).toBe(true);
  });

  it('edit mode: prefilled, no secret choice, Save button', () => {
    setup({ mode: 'edit', initial: { label: 'L', instructionText: 'a\nb' } });
    expect((screen.getByLabelText('Label') as HTMLInputElement).value).toBe('L');
    expect((screen.getByLabelText('Instruction text') as HTMLTextAreaElement).value).toBe('a\nb');
    expect(screen.queryByLabelText('Generate')).toBeNull();
    expect(submitButton().textContent).toBe('Save');
    expect(submitButton().disabled).toBe(false);
  });

  it('submits a trimmed label and the instruction untouched, with no takeSecret for Generate', async () => {
    const submit = setup();
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: '  Alerts ' } });
    fireEvent.change(screen.getByLabelText('Instruction text'), { target: { value: ' a\nb\n ' } });
    await userEvent.setup().click(submitButton());

    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit).toHaveBeenCalledWith({ label: 'Alerts', instructionText: ' a\nb\n ' });
  });

  it('hands an entered secret over through a one-shot reader and clears the field at submit', async () => {
    const submit = setup();
    const user = userEvent.setup();
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'L' } });
    fireEvent.change(screen.getByLabelText('Instruction text'), { target: { value: 'x' } });
    await user.click(screen.getByLabelText('Enter my own'));
    fireEvent.change(screen.getByLabelText('Secret'), { target: { value: ENTERED } });

    await user.click(submitButton());

    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    const payload = submit.mock.calls[0]![0] as EndpointFormPayload;
    expect(JSON.stringify(payload)).not.toContain(ENTERED);
    expect(payload.takeSecret?.()).toBe(ENTERED);
    expect(payload.takeSecret?.()).toBeUndefined();
    expect((screen.getByLabelText('Secret') as HTMLInputElement).value).toBe('');
  });

  it('keeps label and instruction when the submit callback rejects', async () => {
    const submit = setup({ onSubmit: async () => { throw new Error('nope'); } });
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Keep' } });
    fireEvent.change(screen.getByLabelText('Instruction text'), { target: { value: 'me' } });
    await userEvent.setup().click(submitButton());

    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect((screen.getByLabelText('Label') as HTMLInputElement).value).toBe('Keep');
    expect((screen.getByLabelText('Instruction text') as HTMLTextAreaElement).value).toBe('me');
  });

  it('disables the controls and the submit while pending', () => {
    setup({ isPending: true });
    expect((screen.getByLabelText('Label') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('Instruction text') as HTMLTextAreaElement).disabled).toBe(true);
    expect(submitButton().disabled).toBe(true);
  });

  it('boundaries: label 100/101, instruction 4000/4001, empty and blank', () => {
    setup();
    const label = screen.getByLabelText('Label');
    const instruction = screen.getByLabelText('Instruction text');
    fireEvent.change(label, { target: { value: 'a'.repeat(100) } });
    fireEvent.change(instruction, { target: { value: 'a'.repeat(4000) } });
    expect(submitButton().disabled).toBe(false);

    fireEvent.change(label, { target: { value: 'a'.repeat(101) } });
    expect(screen.getByText('Label must be at most 100 characters')).toBeTruthy();
    expect(submitButton().disabled).toBe(true);
    fireEvent.change(label, { target: { value: 'a' } });
    fireEvent.change(instruction, { target: { value: 'a'.repeat(4001) } });
    expect(screen.getByText('Instruction text must be at most 4000 characters')).toBeTruthy();
    expect(submitButton().disabled).toBe(true);
    fireEvent.change(instruction, { target: { value: '   ' } });
    expect(screen.getByText('Instruction text is required')).toBeTruthy();
    fireEvent.change(label, { target: { value: '' } });
    expect(submitButton().disabled).toBe(true);
  });
});
