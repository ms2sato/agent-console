import { describe, it, expect } from 'bun:test';
import { resolveLoggerConfig } from '../logger.js';

describe('resolveLoggerConfig', () => {
  describe("NODE_ENV==='test' (Bun's bun test default)", () => {
    it('does not construct the pino-pretty transport (no worker thread)', () => {
      const config = resolveLoggerConfig('test');

      expect(config.transport).toBeUndefined();
    });

    it('disables the logger to silence output during test runs', () => {
      const config = resolveLoggerConfig('test');

      expect(config.enabled).toBe(false);
    });

    it('is classified as isTest, not isDev or isProduction', () => {
      const config = resolveLoggerConfig('test');

      expect(config.isTest).toBe(true);
      expect(config.isDev).toBe(false);
      expect(config.isProduction).toBe(false);
    });

    it('uses the info level (matches non-dev level selection)', () => {
      const config = resolveLoggerConfig('test');

      expect(config.level).toBe('info');
    });
  });

  describe("NODE_ENV==='production'", () => {
    it('does not construct a transport (regression guard: unchanged behavior)', () => {
      const config = resolveLoggerConfig('production');

      expect(config.transport).toBeUndefined();
    });

    it('keeps the logger enabled (not silenced)', () => {
      const config = resolveLoggerConfig('production');

      expect(config.enabled).toBe(true);
    });

    it('is classified as isProduction, not isDev or isTest', () => {
      const config = resolveLoggerConfig('production');

      expect(config.isProduction).toBe(true);
      expect(config.isDev).toBe(false);
      expect(config.isTest).toBe(false);
    });

    it('uses the info level', () => {
      const config = resolveLoggerConfig('production');

      expect(config.level).toBe('info');
    });
  });

  describe('NODE_ENV unset or development (regression guard for `bun run dev`)', () => {
    it('constructs the pino-pretty transport when NODE_ENV is undefined', () => {
      const config = resolveLoggerConfig(undefined);

      expect(config.transport).toEqual({
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,hostname',
        },
      });
    });

    it('constructs the pino-pretty transport when NODE_ENV is "development"', () => {
      const config = resolveLoggerConfig('development');

      expect(config.transport).toEqual({
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,hostname',
        },
      });
    });

    it('keeps the logger enabled when NODE_ENV is unset', () => {
      const config = resolveLoggerConfig(undefined);

      expect(config.enabled).toBe(true);
    });

    it('is classified as isDev when NODE_ENV is unset', () => {
      const config = resolveLoggerConfig(undefined);

      expect(config.isDev).toBe(true);
      expect(config.isProduction).toBe(false);
      expect(config.isTest).toBe(false);
    });

    it('uses the debug level when NODE_ENV is unset', () => {
      const config = resolveLoggerConfig(undefined);

      expect(config.level).toBe('debug');
    });

    it('treats any other unrecognized value (e.g. "staging") as dev-like', () => {
      const config = resolveLoggerConfig('staging');

      expect(config.isDev).toBe(true);
      expect(config.transport).toBeDefined();
      expect(config.enabled).toBe(true);
    });
  });
});
