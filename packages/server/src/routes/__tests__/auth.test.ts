/**
 * Tests for auth routes (POST /login, POST /logout, GET /me).
 *
 * Uses a mock UserMode to control authentication behavior
 * without requiring real OS credential validation or JWT secrets.
 */
import { describe, it, expect } from 'bun:test';
import { Hono } from 'hono';
import { auth } from '../auth.js';
import { onApiError } from '../../lib/error-handler.js';
import type { AppBindings, AppContext } from '../../app-context.js';
import type { UserMode, LoginResult } from '../../services/user-mode.js';
import type { AuthUser } from '@agent-console/shared';
import type { PtyInstance } from '../../lib/pty-provider.js';
import type { PtySpawnRequest } from '../../services/user-mode.js';

// ============================================================================
// Mock UserMode implementations
// ============================================================================

/**
 * Create a mock UserMode for testing route handlers.
 * Allows controlling what authenticate() and login() return.
 */
function createMockUserMode(options: {
  authenticateResult?: AuthUser | null;
  loginResult?: LoginResult | null;
} = {}): UserMode {
  return {
    authenticate: () => options.authenticateResult ?? null,
    login: async () => options.loginResult ?? null,
    spawnPty: (_request: PtySpawnRequest): PtyInstance => {
      throw new Error('spawnPty not implemented in mock');
    },
  };
}

// ============================================================================
// Test App Factory
// ============================================================================

/**
 * Create a test Hono app with auth routes mounted.
 * The auth routes in the real app are mounted at /api/auth, so we replicate that.
 */
function createTestApp(userMode: UserMode): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  // Inject appContext middleware
  app.use('*', async (c, next) => {
    c.set('appContext', { userMode } as AppContext);
    await next();
  });

  app.onError(onApiError);
  app.route('/api/auth', auth);

  return app;
}

// ============================================================================
// Test Constants
// ============================================================================

const TEST_USER: AuthUser = {
  id: 'user-uuid-123',
  username: 'alice',
  homeDir: '/home/alice',
};

// ============================================================================
// Tests
// ============================================================================

describe('Auth Routes', () => {
  // =========================================================================
  // POST /api/auth/login
  // =========================================================================

  describe('POST /api/auth/login', () => {
    it('should return 401 for invalid credentials', async () => {
      const userMode = createMockUserMode({ loginResult: null });
      const app = createTestApp(userMode);

      const res = await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'alice', password: 'wrong' }),
      });

      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('Invalid credentials');
    });

    it('should return 200 with user data on successful login', async () => {
      const userMode = createMockUserMode({
        loginResult: {
          user: TEST_USER,
          token: 'test-jwt-token-abc',
        },
      });
      const app = createTestApp(userMode);

      const res = await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'alice', password: 'correct' }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { user: AuthUser };
      expect(body.user).toEqual(TEST_USER);
    });

    it('should set httpOnly auth_token cookie on successful login', async () => {
      const userMode = createMockUserMode({
        loginResult: {
          user: TEST_USER,
          token: 'test-jwt-token-abc',
        },
      });
      const app = createTestApp(userMode);

      const res = await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'alice', password: 'correct' }),
      });

      expect(res.status).toBe(200);

      // Check Set-Cookie header
      const setCookieHeader = res.headers.get('Set-Cookie');
      expect(setCookieHeader).not.toBeNull();
      expect(setCookieHeader).toContain('auth_token=test-jwt-token-abc');
      expect(setCookieHeader).toContain('HttpOnly');
      expect(setCookieHeader).toContain('Path=/');
      expect(setCookieHeader).toContain('SameSite=Lax');
    });

    it('should return validation error for missing username', async () => {
      const userMode = createMockUserMode();
      const app = createTestApp(userMode);

      const res = await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'test' }),
      });

      // Valibot validation error should result in 400 or similar
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('should return validation error for missing password', async () => {
      const userMode = createMockUserMode();
      const app = createTestApp(userMode);

      const res = await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'alice' }),
      });

      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('should return validation error for empty body', async () => {
      const userMode = createMockUserMode();
      const app = createTestApp(userMode);

      const res = await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBeGreaterThanOrEqual(400);
    });
  });

  // =========================================================================
  // POST /api/auth/logout
  // =========================================================================

  describe('POST /api/auth/logout', () => {
    it('should return 200 with success true', async () => {
      const userMode = createMockUserMode();
      const app = createTestApp(userMode);

      const res = await app.request('/api/auth/logout', {
        method: 'POST',
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean };
      expect(body.success).toBe(true);
    });

    it('should delete the auth_token cookie', async () => {
      const userMode = createMockUserMode();
      const app = createTestApp(userMode);

      const res = await app.request('/api/auth/logout', {
        method: 'POST',
      });

      expect(res.status).toBe(200);

      // deleteCookie sets the cookie with max-age=0 to expire it
      const setCookieHeader = res.headers.get('Set-Cookie');
      expect(setCookieHeader).not.toBeNull();
      expect(setCookieHeader).toContain('auth_token=');
      expect(setCookieHeader).toContain('Max-Age=0');
    });
  });

  // =========================================================================
  // GET /api/auth/me
  // =========================================================================

  describe('GET /api/auth/me', () => {
    it('should return { user: null } when unauthenticated', async () => {
      const userMode = createMockUserMode({ authenticateResult: null });
      const app = createTestApp(userMode);

      const res = await app.request('/api/auth/me');

      expect(res.status).toBe(200);
      const body = (await res.json()) as { user: AuthUser | null };
      expect(body.user).toBeNull();
    });

    it('should return { user: AuthUser } when authenticated', async () => {
      const userMode = createMockUserMode({ authenticateResult: TEST_USER });
      const app = createTestApp(userMode);

      const res = await app.request('/api/auth/me');

      expect(res.status).toBe(200);
      const body = (await res.json()) as { user: AuthUser };
      expect(body.user).toEqual(TEST_USER);
    });

    it('should not return 401 even when unauthenticated', async () => {
      // The /me endpoint deliberately returns null instead of 401
      // so the client can check auth status without triggering error handling
      const userMode = createMockUserMode({ authenticateResult: null });
      const app = createTestApp(userMode);

      const res = await app.request('/api/auth/me');

      expect(res.status).toBe(200);
    });

    it('should pass cookie to authenticate via resolveToken', async () => {
      // Verify that the auth cookie is correctly passed to userMode.authenticate
      let receivedToken: string | undefined;

      const userMode: UserMode = {
        authenticate: (resolveToken) => {
          receivedToken = resolveToken();
          return TEST_USER;
        },
        login: async () => null,
        spawnPty: () => {
          throw new Error('not implemented');
        },
      };

      const app = createTestApp(userMode);

      await app.request('/api/auth/me', {
        headers: {
          Cookie: 'auth_token=my-jwt-cookie-value',
        },
      });

      expect(receivedToken).toBe('my-jwt-cookie-value');
    });

    it('should return undefined token when no cookie is present', async () => {
      let receivedToken: string | undefined = 'should-be-replaced';

      const userMode: UserMode = {
        authenticate: (resolveToken) => {
          receivedToken = resolveToken();
          return null;
        },
        login: async () => null,
        spawnPty: () => {
          throw new Error('not implemented');
        },
      };

      const app = createTestApp(userMode);

      await app.request('/api/auth/me');

      expect(receivedToken).toBeUndefined();
    });
  });
});
