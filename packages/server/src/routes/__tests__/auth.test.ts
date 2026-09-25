/**
 * Tests for auth routes (POST /login, POST /logout, GET /me).
 *
 * Uses a mock UserMode to control authentication behavior
 * without requiring real OS credential validation or JWT secrets.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { auth, LoginRateLimiter, loginRateLimiter } from '../auth.js';
import { onApiError } from '../../lib/error-handler.js';
import { AUTH_COOKIE_NAME } from '../../lib/auth-constants.js';
import { serverConfig } from '../../lib/server-config.js';
import type { AppBindings, AppContext } from '../../app-context.js';
import type { UserMode, LoginResult } from '../../services/user-mode.js';
import type { AuthUser, UserPreferences } from '@agent-console/shared';
import type { PtyInstance } from '../../lib/pty-provider.js';
import type { PtySpawnRequest } from '../../services/user-mode.js';
import type { UserRepository } from '../../repositories/user-repository.js';
import { createMockSystemCapabilities } from '../../__tests__/utils/mock-system-capabilities-helper.js';

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

/**
 * In-memory fake `UserRepository`, exposing only the two preferences
 * methods `routes/auth.ts` actually calls -- `upsertByOsUid`/`findById`
 * throw if reached, since no auth route under test needs them.
 */
function createMockUserRepository(seed: Record<string, UserPreferences> = {}): UserRepository {
  const store = new Map<string, UserPreferences>(Object.entries(seed));
  return {
    upsertByOsUid: async () => {
      throw new Error('upsertByOsUid not implemented in mock');
    },
    findById: async () => {
      throw new Error('findById not implemented in mock');
    },
    getPreferences: async (id) => store.get(id) ?? null,
    setPreferences: async (id, preferences) => {
      store.set(id, preferences);
      return true;
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
function createTestApp(userMode: UserMode, userRepository: UserRepository = createMockUserRepository()): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  // Inject appContext middleware
  app.use('*', async (c, next) => {
    c.set('appContext', { userMode, userRepository } as AppContext);
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
      // Secure follows the default (unset AUTH_COOKIE_SECURE) resolution:
      // Secure iff NODE_ENV === 'production'. This verifies the shipping route
      // path uses resolveAuthCookieSecure and preserves current behavior.
      if (serverConfig.NODE_ENV === 'production') {
        expect(setCookieHeader).toContain('Secure');
      } else {
        expect(setCookieHeader).not.toContain('Secure');
      }
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

    it('omits preferences entirely when unauthenticated', async () => {
      const userMode = createMockUserMode({ authenticateResult: null });
      const app = createTestApp(userMode);

      const res = await app.request('/api/auth/me');

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect('preferences' in body).toBe(false);
    });

    it('returns preferences: { disableClaudeAiConnectors: false } when authenticated with no preferences row', async () => {
      const userMode = createMockUserMode({ authenticateResult: TEST_USER });
      const app = createTestApp(userMode);

      const res = await app.request('/api/auth/me');

      expect(res.status).toBe(200);
      const body = (await res.json()) as { preferences: UserPreferences };
      expect(body.preferences).toEqual({ disableClaudeAiConnectors: false });
    });

    it('returns the persisted preferences row when one exists', async () => {
      const userMode = createMockUserMode({ authenticateResult: TEST_USER });
      const userRepository = createMockUserRepository({
        [TEST_USER.id]: { disableClaudeAiConnectors: true },
      });
      const app = createTestApp(userMode, userRepository);

      const res = await app.request('/api/auth/me');

      expect(res.status).toBe(200);
      const body = (await res.json()) as { preferences: UserPreferences };
      expect(body.preferences).toEqual({ disableClaudeAiConnectors: true });
    });
  });

  // =========================================================================
  // PATCH /api/auth/me/preferences
  // =========================================================================

  describe('PATCH /api/auth/me/preferences', () => {
    it('returns 401 when unauthenticated', async () => {
      const userMode = createMockUserMode({ authenticateResult: null });
      const app = createTestApp(userMode);

      const res = await app.request('/api/auth/me/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disableClaudeAiConnectors: true }),
      });

      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('Unauthorized');
    });

    it('returns 400 for a non-boolean disableClaudeAiConnectors value', async () => {
      const userMode = createMockUserMode({ authenticateResult: TEST_USER });
      const app = createTestApp(userMode);

      const res = await app.request('/api/auth/me/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disableClaudeAiConnectors: 'yes' }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 for an unknown key (strict-parse contract, never a caller-supplied id/userId)', async () => {
      const userMode = createMockUserMode({ authenticateResult: TEST_USER });
      const app = createTestApp(userMode);

      const res = await app.request('/api/auth/me/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disableClaudeAiConnectors: true, userId: 'someone-elses-id' }),
      });

      expect(res.status).toBe(400);
    });

    it('sets the preference on the authenticated user and returns { user, preferences }', async () => {
      const userMode = createMockUserMode({ authenticateResult: TEST_USER });
      const userRepository = createMockUserRepository();
      const app = createTestApp(userMode, userRepository);

      const res = await app.request('/api/auth/me/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disableClaudeAiConnectors: true }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { user: AuthUser; preferences: UserPreferences };
      expect(body.user).toEqual(TEST_USER);
      expect(body.preferences).toEqual({ disableClaudeAiConnectors: true });

      // Durable: a subsequent GET /me reflects the same value.
      const meRes = await app.request('/api/auth/me');
      const meBody = (await meRes.json()) as { preferences: UserPreferences };
      expect(meBody.preferences).toEqual({ disableClaudeAiConnectors: true });
    });

    it('acts only on the authenticated caller\'s own id, never a body-supplied one', async () => {
      const OTHER_USER: AuthUser = { id: 'other-user-uuid', username: 'bob', homeDir: '/home/bob' };
      const userMode = createMockUserMode({ authenticateResult: TEST_USER });
      const userRepository = createMockUserRepository({
        [OTHER_USER.id]: { disableClaudeAiConnectors: false },
      });
      const app = createTestApp(userMode, userRepository);

      await app.request('/api/auth/me/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disableClaudeAiConnectors: true }),
      });

      // OTHER_USER's row is untouched -- the body carries no id field at all,
      // so there is no way this request could have targeted it.
      const otherPreferences = await userRepository.getPreferences(OTHER_USER.id);
      expect(otherPreferences).toEqual({ disableClaudeAiConnectors: false });
      const ownPreferences = await userRepository.getPreferences(TEST_USER.id);
      expect(ownPreferences).toEqual({ disableClaudeAiConnectors: true });
    });

    it('returns 404 when setPreferences updates no row, and never calls getPreferences afterwards', async () => {
      const userMode = createMockUserMode({ authenticateResult: TEST_USER });
      const getPreferencesSpy = mock(async () => null);
      const userRepository: UserRepository = {
        upsertByOsUid: async () => {
          throw new Error('upsertByOsUid not used by this test');
        },
        findById: async () => null,
        getPreferences: getPreferencesSpy,
        // No matching user row -- mirrors what a deleted-between-auth-and-write
        // user, or any other "id does not match a row" case, looks like.
        setPreferences: async () => false,
      };
      const app = createTestApp(userMode, userRepository);

      const res = await app.request('/api/auth/me/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disableClaudeAiConnectors: true }),
      });

      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('No user row for the authenticated user');
      // The 404 is decided entirely from setPreferences's return value --
      // getPreferences must never even be called on this path (no `?? body`
      // fallback that would otherwise mask the missing row with an echo).
      expect(getPreferencesSpy).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Rate Limiting (H2)
  // =========================================================================

  describe('POST /api/auth/login - rate limiting', () => {
    beforeEach(() => {
      // Clear module-level rate limiter state between tests for isolation
      loginRateLimiter.clear();
    });

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

  it('should reset after window expires', async () => {
    // Use a very short window for testing
    const limiter = new LoginRateLimiter(1, 1); // 1ms window

    limiter.recordAttempt('user1');
    expect(limiter.isBlocked('user1')).toBe(true);

    // Wait for window to expire
    await Bun.sleep(10);

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
        serverPort: Number(serverConfig.PORT),
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
    const body = (await res.json()) as { authMode: string; homeDir: string; serverPort: number };
    expect(body.authMode).toBe(serverConfig.AUTH_MODE);
    expect(body.homeDir).toBe(TEST_USER.homeDir);
    expect(body.serverPort).toBe(Number(serverConfig.PORT));
  });

  it('should return empty homeDir when not authenticated', async () => {
    const userMode = createMockUserMode({ authenticateResult: null });
    const app = createConfigTestApp(userMode);

    const res = await app.request('/api/config');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { authMode: string; homeDir: string; serverPort: number };
    expect(body.authMode).toBe(serverConfig.AUTH_MODE);
    expect(body.homeDir).toBe('');
    expect(body.serverPort).toBe(Number(serverConfig.PORT));
  });
});
