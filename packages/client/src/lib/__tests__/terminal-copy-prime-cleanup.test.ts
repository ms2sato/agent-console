/**
 * Tests for the context-menu copy-prime cleanup
 * (packages/client/src/lib/terminal-copy-prime-cleanup.ts).
 *
 * xterm primes its hidden helper textarea for the native context menu on
 * right-click (textarea.value = selection; textarea.select()) but never
 * un-primes it. When no live xterm selection exists, the 'copy' listener
 * declines and the browser default copies the stale primed value — silently
 * wrong clipboard data. These tests pin the pure "is-primed" signature and
 * the installer that clears the prime once the selection it mirrored is gone.
 */
import { describe, expect, it, mock } from 'bun:test';
import {
  isPrimedForContextMenuCopy,
  installCopyPrimeCleanup,
} from '../terminal-copy-prime-cleanup';

describe('isPrimedForContextMenuCopy (pure predicate)', () => {
  it('should be true for a fully-selected non-empty value', () => {
    expect(isPrimedForContextMenuCopy({ value: 'abc', selectionStart: 0, selectionEnd: 3 })).toBe(true);
  });

  it('should be false for an empty value', () => {
    expect(isPrimedForContextMenuCopy({ value: '', selectionStart: 0, selectionEnd: 0 })).toBe(false);
  });

  it('should be false for a partially-selected value', () => {
    expect(isPrimedForContextMenuCopy({ value: 'abc', selectionStart: 0, selectionEnd: 2 })).toBe(false);
  });

  it('should be false for a caret-only position (IME-composition-like)', () => {
    expect(isPrimedForContextMenuCopy({ value: 'abc', selectionStart: 3, selectionEnd: 3 })).toBe(false);
  });

  it('should be false when selection does not start at 0', () => {
    expect(isPrimedForContextMenuCopy({ value: 'abc', selectionStart: 1, selectionEnd: 3 })).toBe(false);
  });
});

interface FakeTextarea {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

/**
 * Minimal stand-in for the subset of the xterm Terminal surface the installer
 * touches: onSelectionChange (to capture the callback), hasSelection, and the
 * textarea. Avoids constructing a real xterm instance.
 */
function makeFakeTerminal(opts: {
  hasSelection: boolean;
  textarea: FakeTextarea | undefined;
}) {
  const dispose = mock(() => {});
  let captured: (() => void) | undefined;
  const terminal = {
    onSelectionChange(cb: () => void) {
      captured = cb;
      return { dispose };
    },
    hasSelection: () => opts.hasSelection,
    textarea: opts.textarea,
  };
  return {
    terminal,
    dispose,
    fire: () => captured?.(),
  };
}

describe('installCopyPrimeCleanup (installer)', () => {
  it('should clear a primed textarea when the selection is gone', () => {
    const ta: FakeTextarea = { value: 'stale', selectionStart: 0, selectionEnd: 5 };
    const fake = makeFakeTerminal({ hasSelection: false, textarea: ta });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    installCopyPrimeCleanup(fake.terminal as any);

    fake.fire();

    expect(ta.value).toBe('');
  });

  it('should not touch the textarea while a selection is live', () => {
    const ta: FakeTextarea = { value: 'stale', selectionStart: 0, selectionEnd: 5 };
    const fake = makeFakeTerminal({ hasSelection: true, textarea: ta });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    installCopyPrimeCleanup(fake.terminal as any);

    fake.fire();

    expect(ta.value).toBe('stale');
  });

  it('should not touch a caret-only (composition-like) textarea', () => {
    const ta: FakeTextarea = { value: 'compose', selectionStart: 7, selectionEnd: 7 };
    const fake = makeFakeTerminal({ hasSelection: false, textarea: ta });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    installCopyPrimeCleanup(fake.terminal as any);

    fake.fire();

    expect(ta.value).toBe('compose');
  });

  it('should not throw when the textarea is undefined (pre-open event)', () => {
    const fake = makeFakeTerminal({ hasSelection: false, textarea: undefined });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    installCopyPrimeCleanup(fake.terminal as any);

    expect(() => fake.fire()).not.toThrow();
  });

  it('should return the disposable from onSelectionChange', () => {
    const fake = makeFakeTerminal({ hasSelection: false, textarea: undefined });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const disposable = installCopyPrimeCleanup(fake.terminal as any);

    disposable.dispose();

    expect(fake.dispose).toHaveBeenCalledTimes(1);
  });
});
