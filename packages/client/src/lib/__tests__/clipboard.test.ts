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

  it('falls back to document.execCommand("copy") when writeText rejects', async () => {
    const writeTextMock = mock(() => Promise.reject(new Error('Clipboard denied')));
    installClipboard(writeTextMock);
    installSecureContext(true);
    const execCommandMock = installExecCommand(true);
    try {
      await expect(copyToClipboard('fallback text')).resolves.toBeUndefined();
      expect(writeTextMock).toHaveBeenCalledWith('fallback text');
      expect(execCommandMock).toHaveBeenCalledWith('copy');
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

  // The execCommand fallback inside a modal dialog. Focus-trap behaviour itself is
  // not reproducible in happy-dom, so the steal is simulated by stubbing the
  // textarea's focus()/select(); the placement and restore assertions are real DOM.
  describe('execCommand fallback inside a dialog', () => {
    const originalTextareaFocus = HTMLTextAreaElement.prototype.focus;
    const originalTextareaSelect = HTMLTextAreaElement.prototype.select;

    function setup(execResult = true) {
      installUndefinedClipboard();
      installSecureContext(false);
      const dialog = document.createElement('div');
      dialog.setAttribute('role', 'dialog');
      const button = document.createElement('button');
      dialog.appendChild(button);
      document.body.appendChild(dialog);
      button.focus();
      const seen: { active: Element | null; parent: Element | null; calls: number } = {
        active: null,
        parent: null,
        calls: 0,
      };
      Object.defineProperty(document, 'execCommand', {
        value: mock(() => {
          seen.calls += 1;
          seen.active = document.activeElement;
          seen.parent = document.activeElement?.parentElement ?? null;
          return execResult;
        }),
        configurable: true,
      });
      return { dialog, button, seen };
    }

    function teardown(dialog: HTMLElement) {
      HTMLTextAreaElement.prototype.focus = originalTextareaFocus;
      HTMLTextAreaElement.prototype.select = originalTextareaSelect;
      dialog.remove();
      restoreClipboard();
      restoreSecureContext();
      restoreExecCommand();
    }

    it('mounts the textarea inside the dialog (not body) and copies while it holds focus', async () => {
      const { dialog, seen } = setup();
      try {
        await copyToClipboard('inside dialog');
        expect(seen.calls).toBe(1);
        expect(seen.active?.tagName).toBe('TEXTAREA');
        expect(seen.parent).toBe(dialog);
        expect(document.querySelector('textarea')).toBeNull();
      } finally {
        teardown(dialog);
      }
    });

    it('restores focus to the previously focused element after a successful copy', async () => {
      const { dialog, button } = setup();
      try {
        await copyToClipboard('x');
        expect(document.activeElement).toBe(button);
      } finally {
        teardown(dialog);
      }
    });

    it('restores focus to the previously focused element after a failed copy', async () => {
      const { dialog, button } = setup(false);
      try {
        await expect(copyToClipboard('x')).rejects.toThrow();
        expect(document.activeElement).toBe(button);
      } finally {
        teardown(dialog);
      }
    });

    it('rejects when the textarea cannot hold focus, even if execCommand would return true', async () => {
      const { dialog, button, seen } = setup(true);
      HTMLTextAreaElement.prototype.focus = () => {};
      try {
        await expect(copyToClipboard('stolen focus')).rejects.toThrow('execCommand("copy") returned false');
        expect(seen.calls).toBe(0);
        expect(document.activeElement).toBe(button);
      } finally {
        teardown(dialog);
      }
    });

    it('rejects when the selection is not the full text', async () => {
      const { dialog, seen } = setup(true);
      HTMLTextAreaElement.prototype.select = function (this: HTMLTextAreaElement) {
        this.setSelectionRange(1, this.value.length);
      };
      try {
        await expect(copyToClipboard('partial selection')).rejects.toThrow('execCommand("copy") returned false');
        expect(seen.calls).toBe(0);
      } finally {
        teardown(dialog);
      }
    });
  });
});
