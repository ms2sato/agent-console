/**
 * Legacy clipboard-copy technique via a temporary hidden textarea + the
 * deprecated `document.execCommand('copy')` API. Used as a fallback when
 * `navigator.clipboard` is unavailable, which happens whenever the page is
 * served from a non-secure context (plain HTTP, e.g. LAN dev-server access
 * at http://192.168.x.x:5173/) -- `navigator.clipboard` is undefined outside
 * HTTPS/localhost, so the modern API silently cannot be used there (#1159).
 *
 * Inside a modal dialog (Radix `Dialog`) a textarea appended to `document.body`
 * is outside the dialog's focus trap, which pulls focus straight back to the
 * previously focused control: `execCommand('copy')` then still returns `true`
 * but copies the (empty) selection of the wrong element. To avoid that, the
 * textarea is mounted inside the nearest `[role="dialog"]` ancestor of the
 * focused element, and the copy is only attempted when the textarea really
 * holds focus and the full text is selected. Otherwise this reports failure
 * instead of a silent success. The previously focused element is restored
 * afterwards.
 */
function copyViaExecCommand(text: string): boolean {
  const previouslyFocused = document.activeElement;
  const container = previouslyFocused?.closest('[role="dialog"]') ?? document.body;

  const textarea = document.createElement('textarea');
  textarea.value = text;
  // Keep off-screen so it never affects layout or scroll position.
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  container.appendChild(textarea);
  try {
    textarea.focus();
    textarea.select();
    if (document.activeElement !== textarea) return false;
    if (textarea.selectionStart !== 0 || textarea.selectionEnd !== text.length) return false;
    return document.execCommand('copy');
  } finally {
    container.removeChild(textarea);
    if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) {
      previouslyFocused.focus();
    }
  }
}

/**
 * Copy `text` to the clipboard, using the modern `navigator.clipboard` API
 * when available and falling back to the legacy `execCommand('copy')`
 * technique otherwise (non-secure context, e.g. LAN access over plain HTTP,
 * or a `navigator.clipboard.writeText` failure). Throws if both the modern
 * API and the fallback fail.
 */
export async function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to the legacy execCommand('copy') technique below.
    }
  }

  if (!copyViaExecCommand(text)) {
    throw new Error('execCommand("copy") returned false');
  }
}
