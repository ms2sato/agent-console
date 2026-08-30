import { describe, it, expect } from 'bun:test';
import { AUTH_COOKIE_NAME } from '../auth-constants.js';

// This module is a single string constant consumed by every cookie-based
// auth call site (middleware/auth.ts, websocket/routes.ts, routes/api.ts,
// routes/auth.ts) to set/read/delete the same cookie under one name. This
// test exists to satisfy packages/server/src/lib/**'s sibling-test coverage
// pattern (Issue #1459) and to fail if the cookie name is changed here
// without the change being deliberate.
describe('AUTH_COOKIE_NAME', () => {
  it('is the stable cookie name every auth call site shares', () => {
    expect(AUTH_COOKIE_NAME).toBe('auth_token');
  });
});
