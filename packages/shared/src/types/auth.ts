export type AuthMode = 'none' | 'multi-user';

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
    vscode: boolean;
  };
  serverPid: number;
  authMode: AuthMode;
  sharedAccountsAvailable: boolean;
}
