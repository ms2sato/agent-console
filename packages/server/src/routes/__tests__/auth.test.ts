/**
 * Tests for auth routes (POST /login, POST /logout, GET /me).
 *
 * Uses a mock UserMode to control authentication behavior
 * without requiring real OS credential validation or JWT secrets.
 */
import { describe, it, expect } from 'bun:test';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { auth, LoginRateLimiter } from '../auth.js';
import { onApiError } from '../../lib/error-handler.js';
import { AUTH_COOKIE_NAME } from '../../lib/auth-constants.js';
import { serverConfig } from '../../lib/server-config.js';
import type { AppBindings, AppContext } from '../../app-context.js';
import type { UserMode, LoginResult } from '../../services/user-mode.js';
import type { AuthUser } from '@agent-console/shared';
import type { PtyInstance } from '../../lib/pty-provider.js';
import type { PtySpawnRequest } from '../../services/user-mode.js';
import type { SystemCapabilitiesService } from '../../services/system-capabilities-service.js';

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

      // Valibot validation error should result in 400
      expect(res.status).toBe(400);
    });

    it('should return validation error for missing password', async () => {
      const userMode = createMockUserMode();
      const app = createTestApp(userMode);

      const res = await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'alice' }),
      });

      expect(res.status).toBe(400);
    });

    it('should return validation error for empty body', async () => {
      const userMode = createMockUserMode();
      const app = createTestApp(userMode);

      const res = await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
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

  // =========================================================================
  // Rate Limiting (H2)
  // =========================================================================

  describe('POST /api/auth/login - rate limiting', () => {
    it('should return 429 after too many failed attempts', async () => {
      const userMode = createMockUserMode({ loginResult: null });
      const app = createTestApp(userMode);

      // Make 5 failed login attempts (default limit)
      for (let i = 0; i < 5; i++) {
        const res = await app.request('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'ratelimit-test-user', password: 'wrong' }),
        });
        expect(res.status).toBe(401);
      }

      // 6th attempt should be rate limited
      const res = await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'ratelimit-test-user', password: 'wrong' }),
      });
      expect(res.status).toBe(429);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('Too many login attempts');
    });

    it('should not rate limit different usernames', async () => {
      const userMode = createMockUserMode({ loginResult: null });
      const app = createTestApp(userMode);

      // Make 5 failed attempts for one user
      for (let i = 0; i < 5; i++) {
        await app.request('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'user-a-ratelimit', password: 'wrong' }),
        });
      }

      // Different user should not be rate limited
      const res = await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'user-b-ratelimit', password: 'wrong' }),
      });
      expect(res.status).toBe(401); // Not 429
    });
  });
});

// =========================================================================
// LoginRateLimiter Unit Tests (H2)
// =========================================================================

describe('LoginRateLimiter', () => {
  it('should not block before max attempts', () => {
    const limiter = new LoginRateLimiter(3, 60_000);

    limiter.recordAttempt('user1');
    limiter.recordAttempt('user1');

    expect(limiter.isBlocked('user1')).toBe(false);
  });

  it('should block after max attempts', () => {
    const limiter = new LoginRateLimiter(3, 60_000);

    limiter.recordAttempt('user1');
    limiter.recordAttempt('user1');
    limiter.recordAttempt('user1');

    expect(limiter.isBlocked('user1')).toBe(true);
  });

  it('should not block unknown users', () => {
    const limiter = new LoginRateLimiter(3, 60_000);

    expect(limiter.isBlocked('unknown-user')).toBe(false);
  });

  it('should clear state on recordSuccess', () => {
    const limiter = new LoginRateLimiter(3, 60_000);

    limiter.recordAttempt('user1');
    limiter.recordAttempt('user1');
    limiter.recordAttempt('user1');
    expect(limiter.isBlocked('user1')).toBe(true);

    limiter.recordSuccess('user1');
    expect(limiter.isBlocked('user1')).toBe(false);
  });

  it('should reset after window expires', () => {
    // Use a very short window for testing
    const limiter = new LoginRateLimiter(1, 1); // 1ms window

    limiter.recordAttempt('user1');
    expect(limiter.isBlocked('user1')).toBe(true);

    // Wait for window to expire (synchronous: the next check will be after resetAt)
    // Since the window is 1ms, by the time we check again it should have expired
    // Use a small busy-wait to ensure time passes
    const start = Date.now();
    while (Date.now() - start < 5) {
      // wait
    }

    expect(limiter.isBlocked('user1')).toBe(false);
  });

  it('should track different users independently', () => {
    const limiter = new LoginRateLimiter(2, 60_000);

    limiter.recordAttempt('user1');
    limiter.recordAttempt('user1');
    limiter.recordAttempt('user2');

    expect(limiter.isBlocked('user1')).toBe(true);
    expect(limiter.isBlocked('user2')).toBe(false);
  });
});

// =========================================================================
// GET /api/config in multi-user mode
// =========================================================================

describe('GET /api/config (multi-user mode)', () => {
  /**
   * Create a mock SystemCapabilitiesService for testing.
   */
  function createMockSystemCapabilities(): SystemCapabilitiesService {
    return {
      detect: async () => {},
      getCapabilities: () => ({ vscode: false }),
      getVSCodeCommand: () => null,
    } as unknown as SystemCapabilitiesService;
  }

  /**
   * Create a test app with the /api/config route that mirrors
   * the production setup in api.ts.
   */
  function createConfigTestApp(userMode: UserMode): Hono<AppBindings> {
    const app = new Hono<AppBindings>();
    const systemCapabilities = createMockSystemCapabilities();

    app.use('*', async (c, next) => {
      c.set('appContext', { userMode, systemCapabilities } as AppContext);
      await next();
    });

    app.onError(onApiError);

    // Mount the /api/config route matching the production code in api.ts
    app.get('/api/config', (c) => {
      const { systemCapabilities: caps, userMode: um } = c.get('appContext');
      const authUser = um.authenticate(() => getCookie(c, AUTH_COOKIE_NAME));
      return c.json({
        homeDir: authUser?.homeDir ?? '',
        capabilities: caps.getCapabilities(),
        serverPid: process.pid,
        authMode: serverConfig.AUTH_MODE,
      });
    });

    return app;
  }

  it('should return authMode and homeDir when authenticated', async () => {
    const userMode = createMockUserMode({ authenticateResult: TEST_USER });
    const app = createConfigTestApp(userMode);

    const res = await app.request('/api/config', {
      headers: { Cookie: 'auth_token=valid-token' },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { authMode: string; homeDir: string };
    expect(body.authMode).toBe(serverConfig.AUTH_MODE);
    expect(body.homeDir).toBe(TEST_USER.homeDir);
  });

  it('should return empty homeDir when not authenticated', async () => {
    const userMode = createMockUserMode({ authenticateResult: null });
    const app = createConfigTestApp(userMode);

    const res = await app.request('/api/config');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { authMode: string; homeDir: string };
    expect(body.authMode).toBe(serverConfig.AUTH_MODE);
    expect(body.homeDir).toBe('');
  });
});
