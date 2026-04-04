/**
 * Client-Server Boundary Test: Skills API
 *
 * Tests that the client fetchSkills() function calls the correct server endpoint
 * and receives the expected response shape.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { Hono } from 'hono';

import {
  createTestApp,
  setupTestEnvironment,
  cleanupTestEnvironment,
} from '@agent-console/server/src/__tests__/test-utils';

import { fetchSkills } from '@agent-console/client/src/lib/api';

import { createFetchBridge, findRequest } from './test-utils';

describe('Client-Server Boundary: Skills API', () => {
  let app: Hono;
  let bridge: ReturnType<typeof createFetchBridge>;

  beforeEach(async () => {
    await setupTestEnvironment();
    app = await createTestApp();
    bridge = createFetchBridge(app);
  });

  afterEach(async () => {
    bridge.restore();
    await cleanupTestEnvironment();
  });

  describe('fetchSkills', () => {
    it('should call GET /api/skills and return skills array', async () => {
      const result = await fetchSkills();

      // Verify the client sent request to the correct endpoint
      const request = findRequest(bridge.capturedRequests, 'GET', '/api/skills');
      expect(request).toBeDefined();
      expect(request!.url).toBe('/api/skills');
      expect(request!.method).toBe('GET');

      // Verify response shape matches SkillsResponse
      expect(result).toHaveProperty('skills');
      expect(Array.isArray(result.skills)).toBe(true);
    });

    it('should return skills with name and description properties', async () => {
      const result = await fetchSkills();

      // scanSkills scans the actual project directory, so we expect at least one skill
      // Each skill must have the SkillDefinition shape
      for (const skill of result.skills) {
        expect(skill).toHaveProperty('name');
        expect(skill).toHaveProperty('description');
        expect(typeof skill.name).toBe('string');
        expect(typeof skill.description).toBe('string');
      }
    });
  });
});
