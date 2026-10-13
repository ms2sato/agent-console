/**
 * Tests for `AlertDialogDescription`.
 *
 * The description renders arbitrary error text through `ErrorDialog`, which
 * can include long unbroken URLs. `break-words` keeps that text wrapping
 * inside the dialog instead of extending past its right edge. This pins the
 * class at the DOM level; the layout itself is verified in a real browser
 * (see the PR's Browser QA).
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { render, screen, cleanup } from '@testing-library/react';

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
} from '../alert-dialog';

const LONG_URL = `https://example.com/${'a'.repeat(280)}`;

function renderDescription(className?: string) {
  render(
    <AlertDialog open>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Error</AlertDialogTitle>
          <AlertDialogDescription className={className}>{LONG_URL}</AlertDialogDescription>
        </AlertDialogHeader>
      </AlertDialogContent>
    </AlertDialog>
  );
  return screen.getByText(LONG_URL);
}

describe('AlertDialogDescription', () => {
  afterEach(() => {
    cleanup();
  });

  it('wraps a 300-character unbroken URL (break-words)', () => {
    expect(LONG_URL.length).toBe(300);

    const description = renderDescription();

    expect(description.className).toContain('break-words');
  });

  it('keeps the base styling and merges a caller-supplied className (additive)', () => {
    const description = renderDescription('text-red-400');

    expect(description.className).toContain('break-words');
    expect(description.className).toContain('text-sm');
    expect(description.className).toContain('text-red-400');
  });
});
