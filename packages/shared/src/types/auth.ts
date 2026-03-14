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
