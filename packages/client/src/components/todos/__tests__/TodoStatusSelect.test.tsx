import { describe, it, expect, mock, afterEach } from 'bun:test';
import { render, screen, cleanup } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { TODO_STATUSES } from '@agent-console/shared';
import { DEFAULT_TODO_STATUS_FILTER, TodoStatusSelect } from '../TodoStatusSelect';

afterEach(cleanup);

describe('TodoStatusSelect', () => {
  it('offers "All" first, then every status in TODO_STATUSES order', () => {
    render(<TodoStatusSelect value="open" onChange={() => {}} />);

    const values = Array.from(screen.getByLabelText('Status filter').querySelectorAll('option')).map((o) => o.getAttribute('value'));
    expect(values).toEqual(['all', ...TODO_STATUSES]);
  });

  it('reflects the value and calls onChange with the chosen value', async () => {
    const onChange = mock((_value: string) => {});
    render(<TodoStatusSelect value="open" onChange={onChange} />);
    const select = screen.getByLabelText('Status filter') as HTMLSelectElement;
    expect(select.value).toBe('open');

    await userEvent.setup().selectOptions(select, 'done');

    expect(onChange).toHaveBeenCalledWith('done');
  });

  it('focusable={false} removes the select from the tab order; the default keeps it', () => {
    const { rerender } = render(<TodoStatusSelect value="all" onChange={() => {}} focusable={false} />);
    expect(screen.getByLabelText('Status filter').getAttribute('tabindex')).toBe('-1');

    rerender(<TodoStatusSelect value="all" onChange={() => {}} />);
    expect(screen.getByLabelText('Status filter').getAttribute('tabindex')).toBeNull();
  });

  it('the shared default is the open items', () => {
    expect(DEFAULT_TODO_STATUS_FILTER).toBe('open');
  });
});
