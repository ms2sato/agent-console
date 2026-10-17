import { describe, it, expect, afterEach, beforeEach, mock, spyOn } from 'bun:test';
import { act, cleanup, render, screen } from '@testing-library/react';
import { TerminalClipboardNotice, CLIPBOARD_NOTICE_TEXT } from '../TerminalClipboardNotice';
import type { ClipboardWriteEvent, TerminalInstance } from '../terminal-store';

// OSC 52 notice (design doc "OSC 52 clipboard"): silent write only with recent own input
// and document focus; otherwise, or on rejection, a click-to-copy notice.

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

  beforeEach(() => {
    writeText = mock((_text: string) => Promise.resolve());
    originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  });

  afterEach(() => {
    cleanup();
    if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
    else Reflect.deleteProperty(navigator, 'clipboard');
  });

  it('gate true (recent input and focus): writes once, shows no notice', async () => {
    spyOn(document, 'hasFocus').mockReturnValue(true);
    const { instance, emit } = makeInstance();
    render(<TerminalClipboardNotice instance={instance} />);
    await act(async () => emit(event('copied', true)));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('copied');
    expect(screen.queryByText(CLIPBOARD_NOTICE_TEXT)).toBeNull();
  });

  it('no recent input: shows the notice and does not write', async () => {
    spyOn(document, 'hasFocus').mockReturnValue(true);
    const { instance, emit } = makeInstance();
    render(<TerminalClipboardNotice instance={instance} />);
    await act(async () => emit(event('copied', false)));
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.getByText(CLIPBOARD_NOTICE_TEXT)).toBeTruthy();
  });

  it('document without focus: shows the notice and does not write', async () => {
    spyOn(document, 'hasFocus').mockReturnValue(false);
    const { instance, emit } = makeInstance();
    render(<TerminalClipboardNotice instance={instance} />);
    await act(async () => emit(event('copied', true)));
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.getByText(CLIPBOARD_NOTICE_TEXT)).toBeTruthy();
  });

  it('clicking the notice writes the pending text and dismisses it', async () => {
    spyOn(document, 'hasFocus').mockReturnValue(false);
    const { instance, emit } = makeInstance();
    render(<TerminalClipboardNotice instance={instance} />);
    await act(async () => emit(event('first', false)));
    await act(async () => screen.getByText(CLIPBOARD_NOTICE_TEXT).click());
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('first');
    expect(screen.queryByText(CLIPBOARD_NOTICE_TEXT)).toBeNull();
  });

  it('a second event replaces the pending text', async () => {
    spyOn(document, 'hasFocus').mockReturnValue(false);
    const { instance, emit } = makeInstance();
    render(<TerminalClipboardNotice instance={instance} />);
    await act(async () => emit(event('first', false)));
    await act(async () => emit(event('second', false)));
    await act(async () => screen.getByText(CLIPBOARD_NOTICE_TEXT).click());
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('second');
  });

  it('a rejected write falls back to the notice', async () => {
    spyOn(document, 'hasFocus').mockReturnValue(true);
    writeText.mockImplementation(() => Promise.reject(new Error('NotAllowedError')));
    const { instance, emit } = makeInstance();
    render(<TerminalClipboardNotice instance={instance} />);
    await act(async () => emit(event('copied', true)));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(screen.getByText(CLIPBOARD_NOTICE_TEXT)).toBeTruthy();
  });

  it('without the Clipboard API the notice is shown', async () => {
    spyOn(document, 'hasFocus').mockReturnValue(true);
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    const { instance, emit } = makeInstance();
    render(<TerminalClipboardNotice instance={instance} />);
    await act(async () => emit(event('copied', true)));
    expect(screen.getByText(CLIPBOARD_NOTICE_TEXT)).toBeTruthy();
  });
});
