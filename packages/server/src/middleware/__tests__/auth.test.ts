import { describe, it, expect } from 'bun:test';
import { Hono } from 'hono';
import type { AuthUser } from '@agent-console/shared';
import { authMiddleware } from '../auth.js';
import type { AppBindings } from '../../app-context.js';
import type { UserMode } from '../../services/user-mode.js';

/**
 * Create a minimal UserMode stub for testing.
 * Only authenticate() is needed by the auth middleware.
 */
function createMockUserMode(authResult: AuthUser | null): UserMode {
  return {
    authenticate: () => authResult,
    login: async () => null,
    spawnPty: () => { throw new Error('not implemented'); },
  };
}

function createApp(userMode: UserMode) {
  const app = new Hono<AppBindings>();

  // Inject appContext with userMode
  app.use('*', async (c, next) => {
    c.set('appContext', { userMode } as AppBindings['Variables']['appContext']);
    await next();
  });

  // Apply auth middleware
  app.use('*', authMiddleware);

  // Test route
  app.get('/test', (c) => {
    const authUser = c.get('authUser');
    return c.json({ username: authUser.username, homeDir: authUser.homeDir });
  });

  return app;
}

describe('Auth Middleware', () => {
  it('should set authUser on context when authenticate succeeds', async () => {
    const mockUser: AuthUser = { id: 'test-id', username: 'testuser', homeDir: '/home/testuser' };
    const app = createApp(createMockUserMode(mockUser));

    const res = await app.request('/test');

    expect(res.status).toBe(200);
    const body = await res.json() as { username: string; homeDir: string };
    expect(body.username).toBe('testuser');
    expect(body.homeDir).toBe('/home/testuser');
  });

  it('should return 401 when authenticate returns null', async () => {
    const app = createApp(createMockUserMode(null));

    const res = await app.request('/test');

    expect(res.status).toBe(401);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe('Unauthorized');
    expect(body.message).toBe('Authentication required');
  });

  it('should pass auth_token cookie to authenticate via resolveToken', async () => {
    let receivedToken: string | undefined;
    const userMode: UserMode = {
      authenticate: (resolveToken) => {
        receivedToken = resolveToken();
        return { id: 'test-id', username: 'testuser', homeDir: '/home/testuser' };
      },
      login: async () => null,
      spawnPty: () => { throw new Error('not implemented'); },
    };

    const app = createApp(userMode);

    await app.request('/test', {
      headers: {
        'Cookie': 'auth_token=my-jwt-token',
      },
    });

    expect(receivedToken).toBe('my-jwt-token');
  });

  it('should pass undefined token when no cookie is present', async () => {
    let receivedToken: string | undefined = 'should-be-overwritten';
    const userMode: UserMode = {
      authenticate: (resolveToken) => {
        receivedToken = resolveToken();
        return { id: 'test-id', username: 'testuser', homeDir: '/home/testuser' };
      },
      login: async () => null,
      spawnPty: () => { throw new Error('not implemented'); },
    };

    const app = createApp(userMode);

    await app.request('/test');

    expect(receivedToken).toBeUndefined();
  });
});
