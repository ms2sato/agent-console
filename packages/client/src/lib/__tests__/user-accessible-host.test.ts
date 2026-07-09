import { describe, it, expect } from 'bun:test';
import {
  getUserAccessibleHost,
  isRemoteAccess,
  bracketHostForUrl,
  type UserAccessibleLocation,
} from '../user-accessible-host';

function loc(protocol: string, hostname: string): UserAccessibleLocation {
  return { protocol, hostname };
}

describe('getUserAccessibleHost', () => {
  it('returns the hostname verbatim', () => {
    expect(getUserAccessibleHost(loc('http:', 'console.example.com'))).toBe('console.example.com');
    expect(getUserAccessibleHost(loc('http:', '192.168.1.5'))).toBe('192.168.1.5');
  });
});

describe('isRemoteAccess', () => {
  it('is false for loopback hosts', () => {
    expect(isRemoteAccess(loc('http:', 'localhost'))).toBe(false);
    expect(isRemoteAccess(loc('http:', '127.0.0.1'))).toBe(false);
    expect(isRemoteAccess(loc('http:', '::1'))).toBe(false);
    // IPv6 loopback may be reported bracketed.
    expect(isRemoteAccess(loc('http:', '[::1]'))).toBe(false);
  });

  it('is true for non-loopback hosts', () => {
    expect(isRemoteAccess(loc('http:', 'example.com'))).toBe(true);
    expect(isRemoteAccess(loc('http:', '192.168.1.5'))).toBe(true);
    expect(isRemoteAccess(loc('http:', '2001:db8::1'))).toBe(true);
  });
});

describe('bracketHostForUrl', () => {
  it('leaves a non-IPv6 hostname unchanged', () => {
    expect(bracketHostForUrl('example.com')).toBe('example.com');
  });

  it('wraps a bare IPv6 literal in brackets', () => {
    expect(bracketHostForUrl('::1')).toBe('[::1]');
    expect(bracketHostForUrl('2001:db8::1')).toBe('[2001:db8::1]');
  });

  it('does not double-bracket an already-bracketed IPv6 literal', () => {
    expect(bracketHostForUrl('[::1]')).toBe('[::1]');
  });
});
