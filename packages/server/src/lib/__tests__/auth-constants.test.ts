import { describe, it, expect } from 'bun:test';
import { AUTH_COOKIE_NAME } from '../auth-constants.js';

// AUTH_COOKIE_NAME names a cookie that persists in every user's browser.
// Changing this value invalidates every deployed session (a silent logout
// for everyone) and breaks any external tooling that reads the cookie by
// name. This pin exists so that change can only happen deliberately, not
// as an incidental edit to this module.
describe('AUTH_COOKIE_NAME', () => {
  it('is the stable cookie name every auth call site shares', () => {
    expect(AUTH_COOKIE_NAME).toBe('auth_token');
  });
});
