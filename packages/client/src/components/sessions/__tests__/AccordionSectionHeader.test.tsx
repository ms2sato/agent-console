import { describe, it, expect, mock, afterEach } from 'bun:test';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { AccordionSectionHeader } from '../AccordionSectionHeader';

afterEach(cleanup);

function renderHeader(props: { isExpanded?: boolean; onToggle?: () => void; withAction?: boolean } = {}) {
  const onToggle = props.onToggle ?? mock(() => {});
  const onAction = mock(() => {});
  const view = render(
    <AccordionSectionHeader
      label="Memo"
      isExpanded={props.isExpanded ?? false}
      onToggle={onToggle}
      toggleAriaLabel={props.isExpanded ? 'Collapse Memo' : 'Expand Memo'}
    >
      {props.withAction ? (
        <button type="button" onClick={onAction} aria-label="Edit memo">
          Edit
        </button>
      ) : undefined}
    </AccordionSectionHeader>,
  );
  return { ...view, onToggle, onAction };
}

describe('AccordionSectionHeader', () => {
  it('calls onToggle once when the trigger is clicked', () => {
    const { onToggle } = renderHeader();
    fireEvent.click(screen.getByRole('button', { name: 'Expand Memo' }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('aria-expanded and the accessible name follow the props', () => {
    const { rerender } = renderHeader({ isExpanded: false });
    const closed = screen.getByRole('button', { name: 'Expand Memo' });
    expect(closed.getAttribute('aria-expanded')).toBe('false');
    expect(closed.textContent).toBe('Memo');

    rerender(
      <AccordionSectionHeader label="Memo" isExpanded={true} onToggle={() => {}} toggleAriaLabel="Collapse Memo" />,
    );
    const open = screen.getByRole('button', { name: 'Collapse Memo' });
    expect(open.getAttribute('aria-expanded')).toBe('true');
  });

  it('the chevron carries the rotation class only when expanded, and is hidden from assistive tech', () => {
    const { rerender } = renderHeader({ isExpanded: false });
    const chevron = screen.getByTestId('accordion-section-chevron');
    expect(chevron.getAttribute('aria-hidden')).toBe('true');
    expect(chevron.className).not.toContain('rotate-90');

    rerender(
      <AccordionSectionHeader label="Memo" isExpanded={true} onToggle={() => {}} toggleAriaLabel="Collapse Memo" />,
    );
    expect(screen.getByTestId('accordion-section-chevron').className).toContain('rotate-90');
  });

  it('the row carries the bottom-border class only when expanded', () => {
    const { rerender } = renderHeader({ isExpanded: false });
    expect(screen.getByTestId('accordion-section-header').className).not.toContain('border-b');

    rerender(
      <AccordionSectionHeader label="Memo" isExpanded={true} onToggle={() => {}} toggleAriaLabel="Collapse Memo" />,
    );
    expect(screen.getByTestId('accordion-section-header').className).toContain('border-b');
  });

  it('a trailing action is not inside the trigger, and clicking it does not call onToggle', () => {
    const { onToggle, onAction } = renderHeader({ withAction: true });
    const trigger = screen.getByRole('button', { name: 'Expand Memo' });
    const action = screen.getByRole('button', { name: 'Edit memo' });

    expect(trigger.contains(action)).toBe(false);
    fireEvent.click(action);
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('the trigger fills the free width so the whole strip is the click target', () => {
    renderHeader();
    expect(screen.getByRole('button', { name: 'Expand Memo' }).className).toContain('flex-1');
  });
});
