import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { Hono } from 'hono';
import type { AppBindings } from '../../app-context.js';
import { setupTestEnvironment, cleanupTestEnvironment, createTestApp } from '../../__tests__/test-utils.js';
import type { SkillDefinition } from '@agent-console/shared';

describe('Skills API', () => {
  let app: Hono<AppBindings>;

  beforeEach(async () => {
    await setupTestEnvironment();
    app = await createTestApp();
  });

  afterEach(async () => {
    await cleanupTestEnvironment();
  });

  describe('GET /api/skills', () => {
    it('should return skills array with correct shape', async () => {
      // scanSkills uses process.cwd() which points to the project root,
      // where .claude/skills/ exists with actual skill definitions
      const res = await app.request('/api/skills');

      expect(res.status).toBe(200);
      const body = (await res.json()) as { skills: SkillDefinition[] };
      expect(Array.isArray(body.skills)).toBe(true);

      // The project has known skills — verify structure
      if (body.skills.length > 0) {
        for (const skill of body.skills) {
          expect(skill.name).toMatch(/^\//);
          expect(typeof skill.description).toBe('string');
          expect(skill.description.length).toBeGreaterThan(0);
        }
      }
    });

    it('should return sorted results', async () => {
      const res = await app.request('/api/skills');

      expect(res.status).toBe(200);
      const body = (await res.json()) as { skills: SkillDefinition[] };
      const names = body.skills.map((s) => s.name);
      const sorted = [...names].sort();
      expect(names).toEqual(sorted);
    });
  });
});
