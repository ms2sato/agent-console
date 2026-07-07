export type AuthMode = 'none' | 'multi-user';

/**
 * Determines how the client opens paths in VS Code.
 * - `local-spawn`: Server spawns `code <path>` locally. Requires a `code` binary
 *   on the server host. Suitable for single-machine setups (server and browser
 *   on the same OS).
 * - `remote-url-scheme`: Client-side navigates to a `vscode://vscode-remote/ssh-remote+HOST<path>`
 *   URL, letting the browser's local VS Code open the remote path over SSH.
 *   Suitable for remote-access setups (server and browser on different machines).
 */
export type VSCodeOpenMode = 'local-spawn' | 'remote-url-scheme';

/**
 * Authenticated user identity.
 *
 * Represents the OS user who is currently authenticated.
 * In single-user mode, this is always the server process user.
 * In multi-user mode, this is the user who logged in via OS credentials.
 */
export interface AuthUser {
  /** Stable user identifier (UUID from users table) */
  id: string;
  username: string;
  homeDir: string;
}

export interface LoginResponse {
  user: AuthUser;
}

export interface CurrentUserResponse {
  user: AuthUser | null;
}

/**
 * Response shape for `GET /api/config`.
 *
 * Returned to the client before authentication so the client can decide
 * whether to render auth UI and which optional features to surface.
 *
 * `sharedAccountsAvailable` is a boolean gate for shared-session UI; the
 * underlying set of shared-account user-ids is intentionally NOT exposed
 * (per docs/design/shared-orchestrator-session.md §UI). Per-session
 * `Session.isShared` is the safe abstraction for client rendering.
 */
export interface ConfigResponse {
  homeDir: string;
  capabilities: {
    /**
     * Whether the "Open in VS Code" UI should be surfaced to the user.
     * Semantics depend on `vscodeOpenMode`:
     * - `local-spawn`: `true` iff a `code` / `code-insiders` binary exists on
     *   the server host.
     * - `remote-url-scheme`: always `true` (the client's local VS Code handles
     *   the URL scheme, so the server's binary presence is irrelevant).
     */
    vscode: boolean;
    vscodeOpenMode: VSCodeOpenMode;
    /**
     * Host to embed in the `vscode://vscode-remote/ssh-remote+HOST<path>` URL
     * when `vscodeOpenMode === 'remote-url-scheme'`. `null` means the client
     * falls back to `window.location.hostname`.
     */
    vscodeRemoteHost: string | null;
  };
  serverPid: number;
  authMode: AuthMode;
  sharedAccountsAvailable: boolean;
}
