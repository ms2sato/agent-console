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

/**
 * Per-user preferences. Persisted on the `users`
 * table; resolved fresh at every `claude-sdk` embedded-agent worker
 * activation from `session.createdBy`, never read from `AuthUser` or the
 * JWT (both are built once at login/boot and would go stale after a PATCH
 * to `/api/auth/me/preferences`). See
 * `packages/server/src/services/resolve-disable-claude-ai-connectors.ts`.
 */
export interface UserPreferences {
  /**
   * When true, this user's `claude-sdk` embedded-agent workers are spawned
   * with the SDK's own claude.ai connectors (Google Drive, Gmail, etc.)
   * disabled. Default `false` (connectors ON). Read once at worker
   * ACTIVATION -- there is no runtime setter, so a change here takes
   * effect at the worker's next activation, not live.
   */
  disableClaudeAiConnectors: boolean;
}

export interface CurrentUserResponse {
  user: AuthUser | null;
  /** Present iff `user` is non-null (omitted for an unauthenticated caller). */
  preferences?: UserPreferences;
}

/** `PATCH /api/auth/me/preferences`'s response body. */
export interface UpdateUserPreferencesResponse {
  user: AuthUser;
  preferences: UserPreferences;
}
