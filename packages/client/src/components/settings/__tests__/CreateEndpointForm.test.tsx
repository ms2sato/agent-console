import { describe, it, expect, mock, afterEach } from 'bun:test';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Repository } from '@agent-console/shared';
import { CreateEndpointForm } from '../CreateEndpointForm';

afterEach(cleanup);

const repositories = [
  { id: 'repo-1', name: 'alpha' },
  { id: 'repo-2', name: 'beta' },
] as Repository[];

type Submit = (r: { label: string; repositoryId: string; instructionText: string }) => Promise<void>;

function setup(onSubmit: Submit = async () => {}, isPending = false, submitBlocked = false) {
  const submit = mock(onSubmit);
  render(<CreateEndpointForm repositories={repositories} isPending={isPending} submitBlocked={submitBlocked} onSubmit={submit} />);
  return submit;
}

const createButton = () => screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement;
const instruction = () => screen.getByLabelText('Instruction text') as HTMLInputElement;

async function fill(user: ReturnType<typeof userEvent.setup>, label: string, text: string) {
  await user.selectOptions(screen.getByLabelText('Repository'), 'repo-1');
  fireEvent.change(screen.getByLabelText('Label'), { target: { value: label } });
  fireEvent.change(instruction(), { target: { value: text } });
}

describe('CreateEndpointForm', () => {
  it('renders the repositories as options and starts with Create disabled', () => {
    setup();
    expect(screen.getByRole('option', { name: 'alpha' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'beta' })).toBeTruthy();
    expect(createButton().disabled).toBe(true);
  });

  it('submits trimmed label, repository and instruction, then clears label and instruction', async () => {
    const user = userEvent.setup();
    const submit = setup();
    await fill(user, '  Alerts  ', 'Triage it');
    expect(createButton().disabled).toBe(false);

    await user.click(createButton());

    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit).toHaveBeenCalledWith({ label: 'Alerts', repositoryId: 'repo-1', instructionText: 'Triage it' });
    await waitFor(() => expect((screen.getByLabelText('Label') as HTMLInputElement).value).toBe(''));
    expect(instruction().value).toBe('');
  });

  it('keeps the input when the submit callback rejects', async () => {
    const user = userEvent.setup();
    const submit = setup(async () => {
      throw new Error('nope');
    });
    await fill(user, 'Alerts', 'Triage it');

    await user.click(createButton());

    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect((screen.getByLabelText('Label') as HTMLInputElement).value).toBe('Alerts');
    expect(instruction().value).toBe('Triage it');
  });

  it('requires a repository', async () => {
    setup();
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'a' } });
    fireEvent.change(instruction(), { target: { value: 'b' } });
    expect(createButton().disabled).toBe(true);
  });

  it('refuses an empty or blank label without showing a message for empty input', async () => {
    const user = userEvent.setup();
    setup();
    await fill(user, '', 'ok');
    expect(createButton().disabled).toBe(true);
    expect(screen.queryByText('Label is required')).toBeNull();

    fireEvent.change(screen.getByLabelText('Label'), { target: { value: '   ' } });
    expect(screen.getByText('Label is required')).toBeTruthy();
    expect(createButton().disabled).toBe(true);
  });

  it('accepts a 100 character label and a 101 character one is refused', async () => {
    const user = userEvent.setup();
    setup();
    await fill(user, 'a'.repeat(100), 'ok');
    expect(createButton().disabled).toBe(false);

    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'a'.repeat(101) } });
    expect(screen.getByText('Label must be at most 100 characters')).toBeTruthy();
    expect(createButton().disabled).toBe(true);
  });

  it('accepts a 300 character instruction and refuses 301 with a message', async () => {
    const user = userEvent.setup();
    setup();
    await fill(user, 'L', 'a'.repeat(300));
    expect(createButton().disabled).toBe(false);
    expect(screen.queryByText(/must be at most 300/)).toBeNull();

    fireEvent.change(instruction(), { target: { value: 'a'.repeat(301) } });
    expect(screen.getByText('Instruction text must be at most 300 characters')).toBeTruthy();
    expect(createButton().disabled).toBe(true);
  });

  it('refuses a blank instruction with a message', async () => {
    const user = userEvent.setup();
    setup();
    await fill(user, 'L', '   ');
    expect(screen.getByText('Instruction text is required')).toBeTruthy();
    expect(createButton().disabled).toBe(true);
  });

  it('refuses to submit while blocked by an unsaved secret, yet keeps the inputs editable', async () => {
    const user = userEvent.setup();
    const submit = setup(async () => {}, false, true);
    await fill(user, 'Alerts', 'Triage it');
    expect(createButton().disabled).toBe(true);
    expect(instruction().disabled).toBe(false);
    expect((screen.getByLabelText('Label') as HTMLInputElement).disabled).toBe(false);

    fireEvent.submit(createButton().closest('form') as HTMLFormElement);
    expect(submit).not.toHaveBeenCalled();
  });

  it('disables the controls while a create is pending', () => {
    setup(async () => {}, true);
    expect((screen.getByLabelText('Repository') as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByLabelText('Label') as HTMLInputElement).disabled).toBe(true);
    expect(instruction().disabled).toBe(true);
    expect((document.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
  });
});
