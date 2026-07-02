/**
 * Tests for createCustomKeyEventHandler
 * (packages/client/src/lib/terminal-key-handler.ts).
 *
 * The handler is xterm.js's attachCustomKeyEventHandler callback. Returning
 * false stops xterm from handling the key; true lets it through.
 *
 * The "D' package" fix adds a Cmd+A branch: it selects the whole buffer so
 * Cmd+C can copy it even while a TUI has DEC mouse tracking enabled (which
 * disables xterm's SelectionService, so drag-copy is dead). Ctrl+A is
 * deliberately NOT intercepted — it is readline's beginning-of-line and must
 * keep reaching the PTY.
 */
import { describe, expect, it, mock } from 'bun:test';
import { createCustomKeyEventHandler } from '../terminal-key-handler';

interface FakeKeyEventInit {
  type?: string;
  key?: string;
  isComposing?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}

function makeEvent(init: FakeKeyEventInit) {
  const preventDefault = mock(() => {});
  const stopPropagation = mock(() => {});
  const event = {
    type: init.type ?? 'keydown',
    key: init.key ?? '',
    isComposing: init.isComposing ?? false,
    shiftKey: init.shiftKey ?? false,
    metaKey: init.metaKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    altKey: init.altKey ?? false,
    preventDefault,
    stopPropagation,
  } as unknown as KeyboardEvent;
  return { event, preventDefault, stopPropagation };
}

function makeDeps() {
  const sendInput = mock((_data: string) => {});
  const selectAll = mock(() => {});
  return { sendInput, selectAll };
}

describe('createCustomKeyEventHandler', () => {
  it('should let IME composition events through without side effects', () => {
    const deps = makeDeps();
    const handler = createCustomKeyEventHandler(deps);
    const { event } = makeEvent({ type: 'keydown', key: 'a', isComposing: true });

    expect(handler(event)).toBe(true);
    expect(deps.sendInput).not.toHaveBeenCalled();
    expect(deps.selectAll).not.toHaveBeenCalled();
  });

  it('should send a soft newline on Shift+Enter and stop terminal handling', () => {
    const deps = makeDeps();
    const handler = createCustomKeyEventHandler(deps);
    const { event, preventDefault, stopPropagation } = makeEvent({
      type: 'keydown',
      key: 'Enter',
      shiftKey: true,
    });

    expect(handler(event)).toBe(false);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(deps.sendInput).toHaveBeenCalledWith('\x0a');
    expect(deps.selectAll).not.toHaveBeenCalled();
  });

  it('should select all on Cmd+A and stop terminal handling', () => {
    const deps = makeDeps();
    const handler = createCustomKeyEventHandler(deps);
    const { event, preventDefault } = makeEvent({
      type: 'keydown',
      key: 'a',
      metaKey: true,
    });

    expect(handler(event)).toBe(false);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(deps.selectAll).toHaveBeenCalledTimes(1);
    expect(deps.sendInput).not.toHaveBeenCalled();
  });

  it('should intercept Cmd+A even when key is uppercase A (caps lock)', () => {
    const deps = makeDeps();
    const handler = createCustomKeyEventHandler(deps);
    const { event } = makeEvent({ type: 'keydown', key: 'A', metaKey: true });

    expect(handler(event)).toBe(false);
    expect(deps.selectAll).toHaveBeenCalledTimes(1);
  });

  it('should NOT intercept Ctrl+A (readline beginning-of-line must reach the PTY)', () => {
    const deps = makeDeps();
    const handler = createCustomKeyEventHandler(deps);
    const { event } = makeEvent({ type: 'keydown', key: 'a', ctrlKey: true });

    expect(handler(event)).toBe(true);
    expect(deps.selectAll).not.toHaveBeenCalled();
  });

  it('should NOT intercept Cmd+Shift+A', () => {
    const deps = makeDeps();
    const handler = createCustomKeyEventHandler(deps);
    const { event } = makeEvent({
      type: 'keydown',
      key: 'a',
      metaKey: true,
      shiftKey: true,
    });

    expect(handler(event)).toBe(true);
    expect(deps.selectAll).not.toHaveBeenCalled();
  });

  it('should NOT intercept Cmd+A on keyup (keydown-only interception)', () => {
    const deps = makeDeps();
    const handler = createCustomKeyEventHandler(deps);
    const { event } = makeEvent({ type: 'keyup', key: 'a', metaKey: true });

    expect(handler(event)).toBe(true);
    expect(deps.selectAll).not.toHaveBeenCalled();
  });

  it('should let a plain "a" keydown through without side effects', () => {
    const deps = makeDeps();
    const handler = createCustomKeyEventHandler(deps);
    const { event } = makeEvent({ type: 'keydown', key: 'a' });

    expect(handler(event)).toBe(true);
    expect(deps.sendInput).not.toHaveBeenCalled();
    expect(deps.selectAll).not.toHaveBeenCalled();
  });
});
