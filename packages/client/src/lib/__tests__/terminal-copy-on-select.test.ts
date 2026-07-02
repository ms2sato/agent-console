/**
 * Tests for copy-on-select while mouse tracking is active
 * (packages/client/src/lib/terminal-copy-on-select.ts).
 *
 * Under mouse tracking, every reported mouse action counts as user input and
 * synchronously clears the selection, so select-then-copy is unwinnable. This
 * module writes the selection to the clipboard the moment it is created, but
 * ONLY while mouseTrackingMode !== 'none' so normal shells keep standard
 * selection UX. These tests pin the guard conditions and the clipboard call
 * via an injected writer (no real clipboard / xterm needed).
 */
import { describe, expect, it, mock } from 'bun:test';
import {
  installCopyOnSelect,
  type ClipboardWriter,
} from '../terminal-copy-on-select';

type MouseMode = 'none' | 'x10' | 'vt200' | 'drag' | 'any';

function makeFakeTerminal(opts: {
  mouseTrackingMode: MouseMode;
  hasSelection: boolean;
  selection: string;
}) {
  const dispose = mock(() => {});
  let captured: (() => void) | undefined;
  const terminal = {
    onSelectionChange(cb: () => void) {
      captured = cb;
      return { dispose };
    },
    hasSelection: () => opts.hasSelection,
    getSelection: () => opts.selection,
    modes: { mouseTrackingMode: opts.mouseTrackingMode },
  };
  return {
    terminal,
    dispose,
    fire: () => captured?.(),
  };
}

function makeWriter(): ClipboardWriter & { writeText: ReturnType<typeof mock> } {
  return { writeText: mock((_text: string) => Promise.resolve()) };
}

describe('installCopyOnSelect', () => {
  it('should write the selection to the clipboard while tracking is active', () => {
    const fake = makeFakeTerminal({ mouseTrackingMode: 'any', hasSelection: true, selection: 'hello' });
    const writer = makeWriter();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    installCopyOnSelect(fake.terminal as any, writer);

    fake.fire();

    expect(writer.writeText).toHaveBeenCalledTimes(1);
    expect(writer.writeText).toHaveBeenCalledWith('hello');
  });

  it('should NOT write when mouse tracking is off (normal shells unaffected)', () => {
    const fake = makeFakeTerminal({ mouseTrackingMode: 'none', hasSelection: true, selection: 'hello' });
    const writer = makeWriter();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    installCopyOnSelect(fake.terminal as any, writer);

    fake.fire();

    expect(writer.writeText).not.toHaveBeenCalled();
  });

  it('should NOT write when there is no selection', () => {
    const fake = makeFakeTerminal({ mouseTrackingMode: 'any', hasSelection: false, selection: '' });
    const writer = makeWriter();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    installCopyOnSelect(fake.terminal as any, writer);

    fake.fire();

    expect(writer.writeText).not.toHaveBeenCalled();
  });

  it('should NOT write an empty-string selection', () => {
    const fake = makeFakeTerminal({ mouseTrackingMode: 'any', hasSelection: true, selection: '' });
    const writer = makeWriter();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    installCopyOnSelect(fake.terminal as any, writer);

    fake.fire();

    expect(writer.writeText).not.toHaveBeenCalled();
  });

  it('should route a writer rejection to onError without an unhandled rejection', async () => {
    const fake = makeFakeTerminal({ mouseTrackingMode: 'drag', hasSelection: true, selection: 'boom' });
    const writer: ClipboardWriter = { writeText: () => Promise.reject(new Error('denied')) };
    const onError = mock((_e: unknown) => {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    installCopyOnSelect(fake.terminal as any, writer, onError);

    fake.fire();
    // Let the rejected promise settle.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][0] as Error).message).toBe('denied');
  });

  it('should return the disposable from onSelectionChange', () => {
    const fake = makeFakeTerminal({ mouseTrackingMode: 'any', hasSelection: false, selection: '' });
    const writer = makeWriter();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const disposable = installCopyOnSelect(fake.terminal as any, writer);

    disposable.dispose();

    expect(fake.dispose).toHaveBeenCalledTimes(1);
  });
});
