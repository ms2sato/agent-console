// Re-export the schema-derived response type for `GET /api/config`. The
// schema (packages/shared/src/schemas/auth.ts) is the single source of
// truth for its shape; see that file for the field-level doc comments.
export type { ConfigResponse } from '../schemas/auth.js';

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
