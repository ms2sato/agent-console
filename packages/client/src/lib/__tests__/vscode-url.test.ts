import { describe, it, expect } from 'bun:test';
import { buildVSCodeRemoteUrl } from '../vscode-url';

describe('buildVSCodeRemoteUrl', () => {
  it('encodes a root path', () => {
    expect(buildVSCodeRemoteUrl('/', 'host')).toBe(
      'vscode://vscode-remote/ssh-remote+host/'
    );
  });

  it('encodes a typical path with no special characters', () => {
    expect(buildVSCodeRemoteUrl('/home/user/foo.ts', 'host')).toBe(
      'vscode://vscode-remote/ssh-remote+host/home/user/foo.ts'
    );
  });

  it('percent-encodes spaces in path segments (preserves / as separator)', () => {
    expect(buildVSCodeRemoteUrl('/home/user/foo bar.ts', 'host')).toBe(
      'vscode://vscode-remote/ssh-remote+host/home/user/foo%20bar.ts'
    );
  });

  it('percent-encodes multi-byte Unicode in path segments', () => {
    // Japanese "日本語" -> UTF-8 %E6%97%A5%E6%9C%AC%E8%AA%9E
    expect(buildVSCodeRemoteUrl('/home/user/日本語.ts', 'host')).toBe(
      'vscode://vscode-remote/ssh-remote+host/home/user/%E6%97%A5%E6%9C%AC%E8%AA%9E.ts'
    );
  });

  it('percent-encodes URL-reserved special characters (# and ?) in path segments', () => {
    expect(buildVSCodeRemoteUrl('/home/user/a#b?c.ts', 'host')).toBe(
      'vscode://vscode-remote/ssh-remote+host/home/user/a%23b%3Fc.ts'
    );
  });

  it('preserves a host with dots (dots are unreserved in encodeURIComponent)', () => {
    expect(buildVSCodeRemoteUrl('/tmp/x', 'srv.example.com')).toBe(
      'vscode://vscode-remote/ssh-remote+srv.example.com/tmp/x'
    );
  });

  it('preserves a numeric IPv4 host', () => {
    expect(buildVSCodeRemoteUrl('/tmp/x', '192.168.1.10')).toBe(
      'vscode://vscode-remote/ssh-remote+192.168.1.10/tmp/x'
    );
  });

  it('percent-encodes URL-reserved characters in host (colons, etc.)', () => {
    // IPv6-ish notation; encodeURIComponent encodes ':' -> '%3A'
    expect(buildVSCodeRemoteUrl('/tmp/x', 'fe80::1')).toBe(
      'vscode://vscode-remote/ssh-remote+fe80%3A%3A1/tmp/x'
    );
  });

  it('throws when the path is empty', () => {
    expect(() => buildVSCodeRemoteUrl('', 'host')).toThrow(
      'absolutePath must not be empty'
    );
  });

  it('throws when the host is empty', () => {
    expect(() => buildVSCodeRemoteUrl('/tmp/x', '')).toThrow(
      'host must not be empty'
    );
  });
});
