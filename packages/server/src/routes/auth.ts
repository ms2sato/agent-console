/**
 * Authentication routes.
 *
 * These routes are mounted BEFORE the auth middleware in api.ts,
 * so they are accessible without authentication.
 *
 * - POST /api/auth/login  - Authenticate with OS credentials
 * - POST /api/auth/logout - Clear auth cookie
 * - GET  /api/auth/me     - Get current user (no 401, returns null if unauthenticated)
 */

import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { LoginRequestSchema } from '@agent-console/shared';
import { vValidator } from '../middleware/validation.js';
import type { AppBindings } from '../app-context.js';
import { serverConfig } from '../lib/server-config.js';
import { AUTH_COOKIE_NAME } from '../lib/auth-constants.js';

/** Cookie max-age in seconds (7 days, matches JWT expiry) */
const AUTH_COOKIE_MAX_AGE = 7 * 24 * 60 * 60;

// ========== Login Rate Limiter ==========

/** Simple per-username rate limiter for login attempts */
class LoginRateLimiter {
  private attempts = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private maxAttempts: number = 5,
    private windowMs: number = 60_000, // 1 minute
  ) {}

  isBlocked(username: string): boolean {
    const now = Date.now();
    const entry = this.attempts.get(username);
    if (!entry) return false;
    if (now >= entry.resetAt) {
      this.attempts.delete(username);
      return false;
    }
    return entry.count >= this.maxAttempts;
  }

  recordAttempt(username: string): void {
    const now = Date.now();
    const entry = this.attempts.get(username);
    if (!entry || now >= entry.resetAt) {
      this.attempts.set(username, { count: 1, resetAt: now + this.windowMs });
    } else {
      entry.count++;
    }
  }

  recordSuccess(username: string): void {
    this.attempts.delete(username);
  }
}

const loginRateLimiter = new LoginRateLimiter();

// ========== Routes ==========

const auth = new Hono<AppBindings>()
  .post('/login', vValidator(LoginRequestSchema), async (c) => {
    const { userMode } = c.get('appContext');
    const { username, password } = c.req.valid('json');

    // Check rate limiting before attempting login
    if (loginRateLimiter.isBlocked(username)) {
      return c.json({ error: 'Too many login attempts. Try again later.' }, 429);
    }

    const result = await userMode.login(username, password);
    if (!result) {
      loginRateLimiter.recordAttempt(username);
      return c.json({ error: 'Invalid credentials' }, 401);
    }

    // Clear rate limit state on successful login
    loginRateLimiter.recordSuccess(username);

    // Set httpOnly cookie with the token
    setCookie(c, AUTH_COOKIE_NAME, result.token, {
      httpOnly: true,
      secure: serverConfig.NODE_ENV === 'production',
      sameSite: 'Lax',
      path: '/',
      maxAge: AUTH_COOKIE_MAX_AGE,
    });

    return c.json({ user: result.user });
  })
  .post('/logout', (c) => {
    deleteCookie(c, AUTH_COOKIE_NAME, { path: '/' });
    return c.json({ success: true });
  })
  .get('/me', (c) => {
    const { userMode } = c.get('appContext');

    // No 401 on failure - returns null if unauthenticated.
    // In single-user mode, always returns the server process user.
    const authUser = userMode.authenticate(() => getCookie(c, AUTH_COOKIE_NAME));

    return c.json({ user: authUser });
  });

export { auth, LoginRateLimiter };
