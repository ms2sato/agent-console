/**
 * Client-Server Boundary Test: Config API
 *
 * Exercises the full `fetchConfig()` client function -> `/api/config` server
 * handler -> JSON response round-trip. Unit tests on either side alone cannot
 * catch schema drift or field-name mismatches at the wire boundary; this
 * boundary test locks the shape.
 *
 * The load-bearing assertion for this PR is that `serverPort` -- a new field
 * on `ConfigResponse` populated server-side from `serverConfig.PORT` and
 * consumed by `packages/client/src/main.tsx` via `setServerPort()` -- reaches
 * the client with the correct numeric shape and value.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { Hono } from 'hono';

import {
  createTestApp,
  setupTestEnvironment,
  cleanupTestEnvironment,
} from '@agent-console/server/src/__tests__/test-utils';
import { SystemCapabilitiesService } from '@agent-console/server/src/services/system-capabilities-service';
import { serverConfig } from '@agent-console/server/src/lib/server-config';

import { fetchConfig } from '@agent-console/client/src/lib/api';
import type { ConfigResponse } from '@agent-console/shared';

import { createFetchBridge, findRequest } from './test-utils';

/**
 * Minimal SystemCapabilitiesService mock that seeds private state via Reflect
 * so we avoid running the underlying `which` shell-out. Mirrors the pattern
 * used in `packages/server/src/routes/__tests__/api.test.ts`.
 */
function createMockSystemCapabilities(vscodeAvailable: boolean = false): SystemCapabilitiesService {
  const service = new SystemCapabilitiesService();
  Reflect.set(service, 'capabilities', { vscode: vscodeAvailable });
  Reflect.set(service, 'vscodeCommand', vscodeAvailable ? 'code' : null);
  return service;
}

describe('Client-Server Boundary: Config API', () => {
  let app: Hono;
  let bridge: ReturnType<typeof createFetchBridge>;

  beforeEach(async () => {
    await setupTestEnvironment();
    app = await createTestApp({
      systemCapabilities: createMockSystemCapabilities(),
    });
    bridge = createFetchBridge(app);
  });

  afterEach(async () => {
    bridge.restore();
    await cleanupTestEnvironment();
  });

  describe('fetchConfig', () => {
    it('should call GET /api/config and return a ConfigResponse with serverPort', async () => {
      const result: ConfigResponse = await fetchConfig();

      // Verify the client sent the request to the correct endpoint.
      const request = findRequest(bridge.capturedRequests, 'GET', '/api/config');
      expect(request).toBeDefined();
      expect(request!.url).toBe('/api/config');
      expect(request!.method).toBe('GET');

      // Load-bearing wire-shape assertion for the new `serverPort` field.
      // Server populates from `serverConfig.PORT` (`process.env.PORT || '3457'`).
      const expectedPort = Number(serverConfig.PORT);
      expect(typeof result.serverPort).toBe('number');
      expect(result.serverPort).toBe(expectedPort);
      expect(Number.isFinite(result.serverPort)).toBe(true);
      expect(Number.isInteger(result.serverPort)).toBe(true);
      expect(result.serverPort).toBeGreaterThan(0);
    });

    it('should return a response that carries the ConfigResponse contract fields', async () => {
      const result = await fetchConfig();

      // Sanity-check the rest of the shape survives serialization so a
      // silently-dropped sibling field would surface here alongside a
      // `serverPort` regression.
      expect(result).toHaveProperty('homeDir');
      expect(typeof result.homeDir).toBe('string');
      expect(result).toHaveProperty('capabilities');
      expect(typeof result.capabilities).toBe('object');
      expect(typeof result.capabilities.vscode).toBe('boolean');
      expect(result).toHaveProperty('serverPid');
      expect(typeof result.serverPid).toBe('number');
      expect(result).toHaveProperty('serverPort');
      expect(result).toHaveProperty('authMode');
      expect(['none', 'multi-user']).toContain(result.authMode);
      expect(result).toHaveProperty('sharedAccountsAvailable');
      expect(typeof result.sharedAccountsAvailable).toBe('boolean');
    });
  });
});
