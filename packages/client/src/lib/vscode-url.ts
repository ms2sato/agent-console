/**
 * Build a `vscode://vscode-remote/ssh-remote+HOST<absolutePath>` URL that opens
 * the file in the local VS Code via the Remote-SSH extension.
 *
 * The absolute path is encoded per-segment (`/` preserved as separator, other
 * chars %-encoded via encodeURIComponent). The host is encoded whole.
 */
export function buildVSCodeRemoteUrl(absolutePath: string, host: string): string {
  if (!absolutePath) {
    throw new Error('absolutePath must not be empty');
  }
  if (!host) {
    throw new Error('host must not be empty');
  }
  const encodedPath = absolutePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `vscode://vscode-remote/ssh-remote+${encodeURIComponent(host)}${encodedPath}`;
}
