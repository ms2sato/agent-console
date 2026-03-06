/**
 * Authenticated user identity.
 *
 * Represents the OS user who is currently authenticated.
 * In single-user mode, this is always the server process user.
 * In multi-user mode, this is the user who logged in via OS credentials.
 */
export interface AuthUser {
  username: string;
  homeDir: string;
}
