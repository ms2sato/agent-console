import { describe, it, expect } from 'bun:test';
import { parseEnvVars } from '../env-parser.js';

describe('parseEnvVars', () => {
  it('should return empty object for null input', () => {
    expect(parseEnvVars(null)).toEqual({});
  });

  it('should return empty object for undefined input', () => {
    expect(parseEnvVars(undefined)).toEqual({});
  });

  it('should return empty object for empty string', () => {
    expect(parseEnvVars('')).toEqual({});
  });

  it('should parse simple KEY=value format', () => {
    const input = 'FOO=bar';
    expect(parseEnvVars(input)).toEqual({ FOO: 'bar' });
  });

  it('should parse multiple lines', () => {
    const input = `FOO=bar
BAZ=qux
HELLO=world`;
    expect(parseEnvVars(input)).toEqual({
      FOO: 'bar',
      BAZ: 'qux',
      HELLO: 'world',
    });
  });

  it('should skip empty lines', () => {
    const input = `FOO=bar

BAZ=qux`;
    expect(parseEnvVars(input)).toEqual({
      FOO: 'bar',
      BAZ: 'qux',
    });
  });

  it('should skip comment lines starting with #', () => {
    const input = `# This is a comment
FOO=bar
# Another comment
BAZ=qux`;
    expect(parseEnvVars(input)).toEqual({
      FOO: 'bar',
      BAZ: 'qux',
    });
  });

  it('should handle values with = in them', () => {
    const input = 'URL=https://example.com?param=value';
    expect(parseEnvVars(input)).toEqual({
      URL: 'https://example.com?param=value',
    });
  });

  it('should handle double-quoted values', () => {
    const input = 'MSG="hello world"';
    expect(parseEnvVars(input)).toEqual({ MSG: 'hello world' });
  });

  it('should handle single-quoted values', () => {
    const input = "MSG='hello world'";
    expect(parseEnvVars(input)).toEqual({ MSG: 'hello world' });
  });

  it('should preserve quotes inside quoted values', () => {
    const input = 'MSG="it\'s a test"';
    expect(parseEnvVars(input)).toEqual({ MSG: "it's a test" });
  });

  it('should remove inline comments after unquoted values', () => {
    const input = 'FOO=bar # this is a comment';
    expect(parseEnvVars(input)).toEqual({ FOO: 'bar' });
  });

  it('should preserve # inside quoted values', () => {
    const input = 'MSG="hello #world"';
    expect(parseEnvVars(input)).toEqual({ MSG: 'hello #world' });
  });

  it('should skip lines without = sign', () => {
    const input = `FOO=bar
INVALID LINE
BAZ=qux`;
    expect(parseEnvVars(input)).toEqual({
      FOO: 'bar',
      BAZ: 'qux',
    });
  });

  it('should skip lines with empty key', () => {
    const input = `=value
FOO=bar`;
    expect(parseEnvVars(input)).toEqual({ FOO: 'bar' });
  });

  it('should trim whitespace from keys', () => {
    const input = '  FOO  =bar';
    expect(parseEnvVars(input)).toEqual({ FOO: 'bar' });
  });

  it('should trim whitespace from unquoted values', () => {
    const input = 'FOO=  bar  ';
    expect(parseEnvVars(input)).toEqual({ FOO: 'bar' });
  });

  it('should handle empty value', () => {
    const input = 'FOO=';
    expect(parseEnvVars(input)).toEqual({ FOO: '' });
  });

  it('should handle CRLF line endings', () => {
    const input = 'FOO=bar\r\nBAZ=qux';
    expect(parseEnvVars(input)).toEqual({
      FOO: 'bar',
      BAZ: 'qux',
    });
  });

  it('should handle multiline real-world example', () => {
    const input = `# Database configuration
DB_HOST=localhost
DB_PORT=5432
DB_USER="app_user"
DB_PASS='secret123'

# API keys
API_KEY=abc123def456
API_URL=https://api.example.com/v1?token=xyz # production endpoint`;

    expect(parseEnvVars(input)).toEqual({
      DB_HOST: 'localhost',
      DB_PORT: '5432',
      DB_USER: 'app_user',
      DB_PASS: 'secret123',
      API_KEY: 'abc123def456',
      API_URL: 'https://api.example.com/v1?token=xyz',
    });
  });
});
