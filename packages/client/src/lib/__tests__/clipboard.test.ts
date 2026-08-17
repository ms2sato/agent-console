import { describe, it, expect, mock } from 'bun:test';
import { copyToClipboard } from '../clipboard';

// Preserve the original clipboard/isSecureContext descriptors so we can
// restore them per-test. happy-dom provides a real clipboard implementation
// and no `window.isSecureContext`; both are stubbed to exercise the
// secure-context and non-secure-context branches deterministically (#1345).
const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(navigator),
  'clipboard',
);
const originalIsSecureContextDescriptor = Object.getOwnPropertyDescriptor(window, 'isSecureContext');

function installClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: mock(writeText) },
    writable: true,
    configurable: true,
  });
}

function installUndefinedClipboard() {
  Object.defineProperty(navigator, 'clipboard', {
    value: undefined,
    writable: true,
    configurable: true,
  });
}

function restoreClipboard() {
  Reflect.deleteProperty(navigator, 'clipboard');
  if (originalClipboardDescriptor && !('clipboard' in navigator)) {
    Object.defineProperty(Object.getPrototypeOf(navigator), 'clipboard', originalClipboardDescriptor);
  }
}

function installSecureContext(value: boolean) {
  Object.defineProperty(window, 'isSecureContext', { value, writable: true, configurable: true });
}

function restoreSecureContext() {
  if (originalIsSecureContextDescriptor) {
    Object.defineProperty(window, 'isSecureContext', originalIsSecureContextDescriptor);
  } else {
    Reflect.deleteProperty(window, 'isSecureContext');
  }
}

function installExecCommand(result: boolean) {
  const execCommandMock = mock(() => result);
  Object.defineProperty(document, 'execCommand', {
    value: execCommandMock,
    configurable: true,
  });
  return execCommandMock;
}

function restoreExecCommand() {
  Reflect.deleteProperty(document, 'execCommand');
}

describe('copyToClipboard', () => {
  it('uses navigator.clipboard.writeText when available in a secure context', async () => {
    const writeTextMock = mock(() => Promise.resolve());
    installClipboard(writeTextMock);
    installSecureContext(true);
    const execCommandMock = installExecCommand(true);

    try {
      await copyToClipboard('hello world');

      expect(writeTextMock).toHaveBeenCalledWith('hello world');
      expect(execCommandMock).not.toHaveBeenCalled();
    } finally {
      restoreClipboard();
      restoreSecureContext();
      restoreExecCommand();
    }
  });

  it('falls back to document.execCommand("copy") when navigator.clipboard is unavailable (non-secure context)', async () => {
    installUndefinedClipboard();
    installSecureContext(false);
    const execCommandMock = installExecCommand(true);

    try {
      await expect(copyToClipboard('fallback text')).resolves.toBeUndefined();
      expect(execCommandMock).toHaveBeenCalledWith('copy');
    } finally {
      restoreClipboard();
      restoreSecureContext();
      restoreExecCommand();
    }
  });

  it('throws when both navigator.clipboard is unavailable and the execCommand fallback fails', async () => {
    installUndefinedClipboard();
    installSecureContext(false);
    const execCommandMock = installExecCommand(false);

    try {
      await expect(copyToClipboard('doomed text')).rejects.toThrow('execCommand("copy") returned false');
      expect(execCommandMock).toHaveBeenCalledWith('copy');
    } finally {
      restoreClipboard();
      restoreSecureContext();
      restoreExecCommand();
    }
  });
});
