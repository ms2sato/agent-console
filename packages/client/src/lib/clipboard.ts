/**
 * Legacy clipboard-copy technique via a temporary hidden textarea + the
 * deprecated `document.execCommand('copy')` API. Used as a fallback when
 * `navigator.clipboard` is unavailable, which happens whenever the page is
 * served from a non-secure context (plain HTTP, e.g. LAN dev-server access
 * at http://192.168.x.x:5173/) -- `navigator.clipboard` is undefined outside
 * HTTPS/localhost, so the modern API silently cannot be used there (#1159).
 */
function copyViaExecCommand(text: string): boolean {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  // Keep off-screen so it never affects layout or scroll position.
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  try {
    textarea.focus();
    textarea.select();
    return document.execCommand('copy');
  } finally {
    document.body.removeChild(textarea);
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
