import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TabLabel } from '../TabLabel';
import { waitForAbsent } from '../../../test/waitForAbsent';
import { completeWireBody } from '../../../test/wire-fixtures';

// Reach (mutation -> the case that fails): dropping the Escape branch fails
// "Escape restores"; dropping the catch fails "a failed rename"; dropping the
// input's keydown stopPropagation fails "keydown inside the input"; deleting the
// settled guard in commit fails "a blur arrives while the Enter commit is still pending".

const originalFetch = globalThis.fetch;
const mockFetch = mock((_input: RequestInfo | URL, _init?: RequestInit) => Promise.resolve(new Response()));
globalThis.fetch = Object.assign(mockFetch, { preconnect: () => {} }) as typeof fetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
});

function okResponse(): Response {
  return new Response(
    JSON.stringify(completeWireBody({ worker: { id: 'w1', type: 'terminal', name: 'new' } })),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function renameCalls() {
  return mockFetch.mock.calls.filter(([, init]) => init?.method === 'PATCH');
}

function renameBodies(): unknown[] {
  return renameCalls().map(([, init]) => JSON.parse(String(init?.body)));
}

describe('TabLabel', () => {
  const onSelect = mock(() => {});
  const onError = mock((_message: string) => {});

  function renderLabel(props: { active?: boolean; name?: string } = {}) {
    return render(
      <div role="tablist">
        <TabLabel
          sessionId="s1"
          workerId="w1"
          name={props.name ?? 'Shell 1'}
          active={props.active ?? true}
          buttonClassName="tab"
          onSelect={onSelect}
          onError={onError}
        />
      </div>,
    );
  }

  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockImplementation(() => Promise.resolve(okResponse()));
    onSelect.mockClear();
    onError.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the name as a tab with no input', () => {
    renderLabel();
    expect(screen.getByRole('tab', { name: 'Shell 1' })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Tab name' })).toBeNull();
  });

  it('double-click turns the label into an input that is prefilled and selected', async () => {
    const user = userEvent.setup();
    renderLabel();
    await user.dblClick(screen.getByRole('tab', { name: 'Shell 1' }));

    const input = screen.getByRole('textbox', { name: 'Tab name' }) as HTMLInputElement;
    expect(input.value).toBe('Shell 1');
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe('Shell 1'.length);
  });

  it('Enter commits the trimmed value and leaves edit mode', async () => {
    const user = userEvent.setup();
    renderLabel();
    await user.dblClick(screen.getByRole('tab', { name: 'Shell 1' }));
    await user.keyboard('  build watch  {Enter}');

    await waitForAbsent(() => screen.queryByRole('textbox', { name: 'Tab name' }));
    expect(renameBodies()).toEqual([{ name: 'build watch' }]);
    expect(renameCalls()[0][0].toString()).toContain('/api/sessions/s1/workers/w1/name');
    expect(onError).not.toHaveBeenCalled();
  });

  it('keeps the input until the request settles, then shows the old name (no optimistic state)', async () => {
    let release: (r: Response) => void = () => {};
    mockFetch.mockImplementation(() => new Promise<Response>((resolve) => { release = resolve; }));
    const user = userEvent.setup();
    renderLabel();
    await user.dblClick(screen.getByRole('tab', { name: 'Shell 1' }));
    await user.keyboard('x{Enter}');

    expect(screen.getByRole('textbox', { name: 'Tab name' })).toBeTruthy();
    release(okResponse());
    await waitForAbsent(() => screen.queryByRole('textbox', { name: 'Tab name' }));
    // The name prop is unchanged: only the server broadcast would change it.
    expect(screen.getByRole('tab', { name: 'Shell 1' })).toBeTruthy();
  });

  it('Escape restores the old label without a request', async () => {
    const user = userEvent.setup();
    renderLabel();
    await user.dblClick(screen.getByRole('tab', { name: 'Shell 1' }));
    await user.keyboard('changed{Escape}');

    expect(screen.queryByRole('textbox', { name: 'Tab name' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'Shell 1' })).toBeTruthy();
    expect(renameCalls().length).toBe(0);
  });

  it('blur commits', async () => {
    const user = userEvent.setup();
    renderLabel();
    await user.dblClick(screen.getByRole('tab', { name: 'Shell 1' }));
    await user.keyboard('logs');
    await user.tab();

    await waitFor(() => expect(renameBodies()).toEqual([{ name: 'logs' }]));
  });

  it('sends a single request when a blur arrives while the Enter commit is still pending', async () => {
    // Reach: deleting the settled guard at the top of commit fails this case. The input stays
    // mounted until the request settles, so a blur during that window would otherwise commit again.
    let resolveRequest: (response: Response) => void = () => {};
    mockFetch.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveRequest = resolve;
        }),
    );
    const user = userEvent.setup();
    renderLabel();
    await user.dblClick(screen.getByRole('tab', { name: 'Shell 1' }));
    await user.keyboard('logs{Enter}');
    const input = screen.getByRole('textbox', { name: 'Tab name' });

    fireEvent.blur(input);
    resolveRequest(okResponse());

    await waitForAbsent(() => screen.queryByRole('textbox', { name: 'Tab name' }));
    expect(renameCalls().length).toBe(1);
  });

  it.each([
    ['empty', '{Backspace}'],
    ['whitespace-only', '{Control>}a{/Control}   '],
    ['unchanged', ''],
  ])('%s input sends nothing and exits edit mode', async (_label, keys) => {
    const user = userEvent.setup();
    renderLabel();
    await user.dblClick(screen.getByRole('tab', { name: 'Shell 1' }));
    if (keys) await user.keyboard(keys);
    await user.keyboard('{Enter}');

    await waitForAbsent(() => screen.queryByRole('textbox', { name: 'Tab name' }));
    expect(renameCalls().length).toBe(0);
  });

  it('a failed rename calls onError and keeps the old name', async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ error: 'boom' }), { status: 500, headers: { 'content-type': 'application/json' } })),
    );
    const user = userEvent.setup();
    renderLabel();
    await user.dblClick(screen.getByRole('tab', { name: 'Shell 1' }));
    await user.keyboard('x{Enter}');

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError.mock.calls[0][0]).toContain('boom');
    await waitForAbsent(() => screen.queryByRole('textbox', { name: 'Tab name' }));
    expect(screen.getByRole('tab', { name: 'Shell 1' })).toBeTruthy();
  });

  it('clicking inside the input neither selects the tab nor submits', async () => {
    // Pins the sibling structure (input is not a child of the tab button), not a click handler.
    const user = userEvent.setup();
    renderLabel();
    await user.dblClick(screen.getByRole('tab', { name: 'Shell 1' }));
    onSelect.mockClear();
    await user.click(screen.getByRole('textbox', { name: 'Tab name' }));

    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Tab name' })).toBeTruthy();
    expect(renameCalls().length).toBe(0);
  });

  it('keydown inside the input does not reach the tab list', async () => {
    const user = userEvent.setup();
    const onTablistKey = mock((_e: unknown) => {});
    render(
      <div role="tablist" onKeyDown={onTablistKey}>
        <TabLabel sessionId="s1" workerId="w1" name="Shell 1" active buttonClassName="tab" onSelect={onSelect} onError={onError} />
      </div>,
    );
    await user.dblClick(screen.getByRole('tab', { name: 'Shell 1' }));
    onTablistKey.mockClear();
    await user.keyboard('{ArrowLeft}a');
    expect(onTablistKey).not.toHaveBeenCalled();
  });

  it.each(['{Enter}', '{F2}'])('%s on the focused tab enters edit mode', async (key) => {
    const user = userEvent.setup();
    renderLabel();
    screen.getByRole('tab', { name: 'Shell 1' }).focus();
    await user.keyboard(key);

    expect(screen.getByRole('textbox', { name: 'Tab name' })).toBeTruthy();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('the pencil enters edit mode', async () => {
    const user = userEvent.setup();
    renderLabel();
    await user.click(screen.getByRole('button', { name: 'Rename Shell 1' }));
    expect(screen.getByRole('textbox', { name: 'Tab name' })).toBeTruthy();
  });

  it('the pencil is in the tab order only on the active tab', () => {
    renderLabel({ active: true });
    expect(screen.getByRole('button', { name: 'Rename Shell 1' }).tabIndex).toBe(0);
    cleanup();
    renderLabel({ active: false });
    expect(screen.getByRole('button', { name: 'Rename Shell 1' }).tabIndex).toBe(-1);
  });
});
