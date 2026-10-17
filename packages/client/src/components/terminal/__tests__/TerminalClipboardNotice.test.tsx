import { describe, it, expect, afterEach, beforeEach, mock, spyOn } from 'bun:test';
import { act, cleanup, render, screen } from '@testing-library/react';
import { TerminalClipboardNotice, CLIPBOARD_NOTICE_TEXT, CLIPBOARD_COPY_FAILED_TEXT } from '../TerminalClipboardNotice';
import type { ClipboardWriteEvent, TerminalInstance } from '../terminal-store';

// OSC 52 notice (design doc "OSC 52 clipboard"): silent write only in single-user mode with
// recent own input and document focus; otherwise, or on rejection, a click-to-copy notice.

type Listener = (event: ClipboardWriteEvent) => void;

function makeInstance(): { instance: Pick<TerminalInstance, 'onClipboardWrite'>; emit: (event: ClipboardWriteEvent) => void } {
  const listeners = new Set<Listener>();
  return {
    instance: {
      onClipboardWrite: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    emit: (event) => {
      for (const l of Array.from(listeners)) l(event);
    },
  };
}

const event = (text: string, recentInput: boolean): ClipboardWriteEvent => ({ text, atMs: 1, recentInput });

describe('TerminalClipboardNotice', () => {
  let writeText: ReturnType<typeof mock<(text: string) => Promise<void>>>;
  let originalClipboard: PropertyDescriptor | undefined;
  let hasFocusSpy: ReturnType<typeof spyOn>;

  function setFocus(focused: boolean) {
    hasFocusSpy.mockReturnValue(focused);
  }

  beforeEach(() => {
    hasFocusSpy = spyOn(document, 'hasFocus');
    writeText = mock((_text: string) => Promise.resolve());
    originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  });

  afterEach(() => {
    cleanup();
    hasFocusSpy.mockRestore();
    if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
    else Reflect.deleteProperty(navigator, 'clipboard');
  });

  it('gate true (recent input and focus): writes once, shows no notice', async () => {
    setFocus(true);
    const { instance, emit } = makeInstance();
    render(<TerminalClipboardNotice instance={instance} allowSilentWrite={true} />);
    await act(async () => emit(event('copied', true)));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('copied');
    expect(screen.queryByText(CLIPBOARD_NOTICE_TEXT)).toBeNull();
  });

  it('multi-user mode (allowSilentWrite false): recent input and focus still show the notice and do not write', async () => {
    setFocus(true);
    const { instance, emit } = makeInstance();
    render(<TerminalClipboardNotice instance={instance} allowSilentWrite={false} />);
    await act(async () => emit(event('copied', true)));
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.getByText(CLIPBOARD_NOTICE_TEXT)).toBeTruthy();
  });

  it('no recent input: shows the notice and does not write', async () => {
    setFocus(true);
    const { instance, emit } = makeInstance();
    render(<TerminalClipboardNotice instance={instance} allowSilentWrite={true} />);
    await act(async () => emit(event('copied', false)));
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.getByText(CLIPBOARD_NOTICE_TEXT)).toBeTruthy();
  });

  it('document without focus: shows the notice and does not write', async () => {
    setFocus(false);
    const { instance, emit } = makeInstance();
    render(<TerminalClipboardNotice instance={instance} allowSilentWrite={true} />);
    await act(async () => emit(event('copied', true)));
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.getByText(CLIPBOARD_NOTICE_TEXT)).toBeTruthy();
  });

  it('clicking the notice writes the pending text and dismisses it', async () => {
    setFocus(false);
    const { instance, emit } = makeInstance();
    render(<TerminalClipboardNotice instance={instance} allowSilentWrite={true} />);
    await act(async () => emit(event('first', false)));
    await act(async () => screen.getByText(CLIPBOARD_NOTICE_TEXT).click());
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('first');
    expect(screen.queryByText(CLIPBOARD_NOTICE_TEXT)).toBeNull();
  });

  it('a second event replaces the pending text', async () => {
    setFocus(false);
    const { instance, emit } = makeInstance();
    render(<TerminalClipboardNotice instance={instance} allowSilentWrite={true} />);
    await act(async () => emit(event('first', false)));
    await act(async () => emit(event('second', false)));
    await act(async () => screen.getByText(CLIPBOARD_NOTICE_TEXT).click());
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('second');
  });

  it('a rejected write falls back to the notice', async () => {
    setFocus(true);
    writeText.mockImplementation(() => Promise.reject(new Error('NotAllowedError')));
    const { instance, emit } = makeInstance();
    render(<TerminalClipboardNotice instance={instance} allowSilentWrite={true} />);
    await act(async () => emit(event('copied', true)));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(screen.getByText(CLIPBOARD_NOTICE_TEXT)).toBeTruthy();
  });

  it('without the Clipboard API the notice is shown', async () => {
    setFocus(true);
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    const { instance, emit } = makeInstance();
    render(<TerminalClipboardNotice instance={instance} allowSilentWrite={true} />);
    await act(async () => emit(event('copied', true)));
    expect(screen.getByText(CLIPBOARD_NOTICE_TEXT)).toBeTruthy();
  });

  function deferred() {
    let resolve!: () => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it('a newer silent write clears a stale pending notice', async () => {
    setFocus(false);
    const { instance, emit } = makeInstance();
    render(<TerminalClipboardNotice instance={instance} allowSilentWrite={true} />);
    await act(async () => emit(event('A', false)));
    expect(screen.getByText(CLIPBOARD_NOTICE_TEXT)).toBeTruthy();
    setFocus(true);
    await act(async () => emit(event('B', true)));
    expect(writeText).toHaveBeenCalledWith('B');
    expect(screen.queryByText(CLIPBOARD_NOTICE_TEXT)).toBeNull();
  });

  it('a superseded silent write rejecting later does not show its text over a newer notice', async () => {
    setFocus(true);
    const a = deferred();
    writeText.mockImplementationOnce(() => a.promise);
    const { instance, emit } = makeInstance();
    render(<TerminalClipboardNotice instance={instance} allowSilentWrite={true} />);
    await act(async () => emit(event('A', true)));
    setFocus(false);
    await act(async () => emit(event('B', false)));
    await act(async () => a.reject(new Error('NotAllowedError')));
    writeText.mockClear();
    await act(async () => screen.getByText(CLIPBOARD_NOTICE_TEXT).click());
    expect(writeText).toHaveBeenCalledWith('B');
  });

  it('a superseded silent write rejecting later does not show a notice over a newer silent write', async () => {
    setFocus(true);
    const a = deferred();
    writeText.mockImplementationOnce(() => a.promise);
    const { instance, emit } = makeInstance();
    render(<TerminalClipboardNotice instance={instance} allowSilentWrite={true} />);
    await act(async () => emit(event('A', true)));
    await act(async () => emit(event('B', true)));
    await act(async () => a.reject(new Error('NotAllowedError')));
    expect(screen.queryByText(CLIPBOARD_NOTICE_TEXT)).toBeNull();
  });

  it('a failed click keeps the notice with failure feedback, and a later success dismisses it', async () => {
    setFocus(false);
    writeText.mockImplementationOnce(() => Promise.reject(new Error('NotAllowedError')));
    const { instance, emit } = makeInstance();
    render(<TerminalClipboardNotice instance={instance} allowSilentWrite={true} />);
    await act(async () => emit(event('first', false)));
    await act(async () => screen.getByText(CLIPBOARD_NOTICE_TEXT).click());
    expect(screen.getByText(CLIPBOARD_NOTICE_TEXT)).toBeTruthy();
    expect(screen.getByText(CLIPBOARD_COPY_FAILED_TEXT)).toBeTruthy();
    expect(CLIPBOARD_COPY_FAILED_TEXT).toBe('Could not copy -- select and copy manually');
    await act(async () => screen.getByText(CLIPBOARD_NOTICE_TEXT).click());
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(CLIPBOARD_NOTICE_TEXT)).toBeNull();
    expect(screen.queryByText(CLIPBOARD_COPY_FAILED_TEXT)).toBeNull();
  });

  it('a new event resets the failure feedback', async () => {
    setFocus(false);
    writeText.mockImplementationOnce(() => Promise.reject(new Error('NotAllowedError')));
    const { instance, emit } = makeInstance();
    render(<TerminalClipboardNotice instance={instance} allowSilentWrite={true} />);
    await act(async () => emit(event('first', false)));
    await act(async () => screen.getByText(CLIPBOARD_NOTICE_TEXT).click());
    await act(async () => emit(event('second', false)));
    expect(screen.queryByText(CLIPBOARD_COPY_FAILED_TEXT)).toBeNull();
    expect(screen.getByText(CLIPBOARD_NOTICE_TEXT)).toBeTruthy();
  });
});
