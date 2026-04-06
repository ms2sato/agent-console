import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { Hono } from 'hono';
import type { AppBindings } from '../../app-context.js';
import { setupTestEnvironment, cleanupTestEnvironment, createTestApp } from '../../__tests__/test-utils.js';
import type { SkillDefinition } from '@agent-console/shared';
import type { MessageTemplateRepository } from '../../repositories/message-template-repository.js';

describe('API route mounting', () => {
  let app: Hono<AppBindings>;

  beforeEach(async () => {
    await setupTestEnvironment();
    app = await createTestApp();
  });

  afterEach(async () => {
    await cleanupTestEnvironment();
  });

  it('should mount skills route at /api/skills', async () => {
    const res = await app.request('/api/skills');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { skills: SkillDefinition[] };
    expect(Array.isArray(body.skills)).toBe(true);
  });

  it('should mount message-templates route at /api/message-templates', async () => {
    app = await createTestApp({
      messageTemplateRepository: { findAll: async () => [] } as Pick<MessageTemplateRepository, 'findAll'> as MessageTemplateRepository,
    });
    const res = await app.request('/api/message-templates');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { templates: unknown[] };
    expect(Array.isArray(body.templates)).toBe(true);
  });
});
