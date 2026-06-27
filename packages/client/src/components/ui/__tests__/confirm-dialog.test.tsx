/**
 * Tests for `ConfirmDialog`.
 *
 * Covers the new optional `children` slot (Issue #905) that lets callers
 * inject content — for example, an opt-in checkbox — between the dialog
 * description and the action footer. The slot is rendered as a sibling
 * of `AlertDialogDescription`, NOT inside it: descriptions render as
 * `<p>`, and nesting form controls inside a `<p>` is invalid HTML that
 * browsers split implicitly.
 *
 * The base props path (title / description / confirm / cancel) is also
 * smoke-tested so future regressions are caught at the dialog level.
 */
import { describe, it, expect, mock, afterEach } from 'bun:test';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

import { ConfirmDialog } from '../confirm-dialog';

describe('ConfirmDialog', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders the title, description, confirm label, and cancel label', () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Delete Item"
        description="Are you sure?"
        confirmLabel="Delete"
        cancelLabel="Keep"
        onConfirm={() => {}}
      />
    );

    expect(screen.getByRole('heading', { name: 'Delete Item' })).toBeTruthy();
    expect(screen.getByText('Are you sure?')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Keep' })).toBeTruthy();
  });

  it('invokes onConfirm when the confirm button is clicked', () => {
    const onConfirm = mock(() => {});
    render(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Stop"
        description="Stop now?"
        confirmLabel="Stop"
        onConfirm={onConfirm}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('does NOT render children when the children prop is omitted', () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Confirm"
        description="Sure?"
        onConfirm={() => {}}
      />
    );

    // No checkbox should appear (no children slot used).
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('renders children between the description and the action footer when provided', () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Confirm"
        description="Sure?"
        onConfirm={() => {}}
      >
        <label>
          <input type="checkbox" />
          Extra opt-in
        </label>
      </ConfirmDialog>
    );

    const checkbox = screen.getByRole('checkbox');
    expect(checkbox).toBeTruthy();
    expect((checkbox as HTMLInputElement).checked).toBe(false);

    // The checkbox label text should be present.
    expect(screen.getByText('Extra opt-in')).toBeTruthy();

    // The injected control must NOT be nested inside the description's <p>
    // (invalid HTML). The description renders as a paragraph.
    const description = screen.getByText('Sure?');
    expect(description.tagName.toLowerCase()).toBe('p');
    expect(description.contains(checkbox)).toBe(false);
  });
});
