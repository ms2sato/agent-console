import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { Hono } from 'hono';
import type { AppBindings } from '../../app-context.js';
import type { MessageTemplate } from '@agent-console/shared';
import { setupTestEnvironment, cleanupTestEnvironment, createTestApp } from '../../__tests__/test-utils.js';

// ---------------------------------------------------------------------------
// Mock repository
// ---------------------------------------------------------------------------

const messageTemplateRepository = {
  findAll: mock(() => Promise.resolve([] as MessageTemplate[])),
  findById: mock(() => Promise.resolve(null as MessageTemplate | null)),
  create: mock(() => Promise.resolve({} as MessageTemplate)),
  update: mock(() => Promise.resolve(null as MessageTemplate | null)),
  delete: mock(() => Promise.resolve(false)),
  reorder: mock(() => Promise.resolve()),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetAllMocks(): void {
  messageTemplateRepository.findAll.mockReset();
  messageTemplateRepository.findById.mockReset();
  messageTemplateRepository.create.mockReset();
  messageTemplateRepository.update.mockReset();
  messageTemplateRepository.delete.mockReset();
  messageTemplateRepository.reorder.mockReset();
}

function makeTemplate(overrides?: Partial<MessageTemplate>): MessageTemplate {
  return {
    id: 'tpl-1',
    title: 'Test Template',
    content: 'Hello {{name}}',
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Message Templates API', () => {
  let app: Hono<AppBindings>;

  beforeEach(async () => {
    await setupTestEnvironment();
    resetAllMocks();
    app = await createTestApp({
      messageTemplateRepository: messageTemplateRepository as any,
    });
  });

  afterEach(async () => {
    await cleanupTestEnvironment();
  });

  // =========================================================================
  // GET /api/message-templates
  // =========================================================================

  describe('GET /api/message-templates', () => {
    it('should return empty template list', async () => {
      messageTemplateRepository.findAll.mockReturnValue(Promise.resolve([]));

      const res = await app.request('/api/message-templates');
      expect(res.status).toBe(200);

      const body = (await res.json()) as { templates: MessageTemplate[] };
      expect(body.templates).toEqual([]);
    });

    it('should return all templates', async () => {
      const templates = [makeTemplate({ id: 'tpl-1' }), makeTemplate({ id: 'tpl-2', sortOrder: 1 })];
      messageTemplateRepository.findAll.mockReturnValue(Promise.resolve(templates));

      const res = await app.request('/api/message-templates');
      expect(res.status).toBe(200);

      const body = (await res.json()) as { templates: MessageTemplate[] };
      expect(body.templates).toHaveLength(2);
    });
  });

  // =========================================================================
  // POST /api/message-templates
  // =========================================================================

  describe('POST /api/message-templates', () => {
    it('should create a template and return 201', async () => {
      const created = makeTemplate();
      messageTemplateRepository.findAll.mockReturnValue(Promise.resolve([]));
      messageTemplateRepository.create.mockReturnValue(Promise.resolve(created));

      const res = await app.request('/api/message-templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Test Template', content: 'Hello {{name}}' }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as { template: MessageTemplate };
      expect(body.template.title).toBe('Test Template');
      expect(messageTemplateRepository.create).toHaveBeenCalled();
    });

    it('should compute sort order based on existing templates', async () => {
      const existing = [makeTemplate({ sortOrder: 5 })];
      messageTemplateRepository.findAll.mockReturnValue(Promise.resolve(existing));
      messageTemplateRepository.create.mockReturnValue(Promise.resolve(makeTemplate({ sortOrder: 6 })));

      await app.request('/api/message-templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'New', content: 'Content' }),
      });

      const createCall = messageTemplateRepository.create.mock.calls[0] as unknown[];
      // Fourth argument is sortOrder
      expect(createCall[3]).toBe(6);
    });

    it('should return 400 when title is missing', async () => {
      const res = await app.request('/api/message-templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Hello' }),
      });

      expect(res.status).toBe(400);
    });

    it('should return 400 when content is missing', async () => {
      const res = await app.request('/api/message-templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Title' }),
      });

      expect(res.status).toBe(400);
    });
  });

  // =========================================================================
  // PUT /api/message-templates/:id
  // =========================================================================

  describe('PUT /api/message-templates/:id', () => {
    it('should update a template', async () => {
      const updated = makeTemplate({ title: 'Updated Title' });
      messageTemplateRepository.update.mockReturnValue(Promise.resolve(updated));

      const res = await app.request('/api/message-templates/tpl-1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Updated Title' }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { template: MessageTemplate };
      expect(body.template.title).toBe('Updated Title');
    });

    it('should return 404 for unknown template id', async () => {
      messageTemplateRepository.update.mockReturnValue(Promise.resolve(null));

      const res = await app.request('/api/message-templates/unknown-id', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Updated' }),
      });

      expect(res.status).toBe(404);
    });
  });

  // =========================================================================
  // DELETE /api/message-templates/:id
  // =========================================================================

  describe('DELETE /api/message-templates/:id', () => {
    it('should delete a template', async () => {
      messageTemplateRepository.delete.mockReturnValue(Promise.resolve(true));

      const res = await app.request('/api/message-templates/tpl-1', { method: 'DELETE' });
      expect(res.status).toBe(200);

      const body = (await res.json()) as { success: boolean };
      expect(body.success).toBe(true);
    });

    it('should return 404 for unknown template id', async () => {
      messageTemplateRepository.delete.mockReturnValue(Promise.resolve(false));

      const res = await app.request('/api/message-templates/unknown-id', { method: 'DELETE' });
      expect(res.status).toBe(404);
    });
  });

  // =========================================================================
  // PUT /api/message-templates/reorder
  // =========================================================================

  describe('PUT /api/message-templates/reorder', () => {
    it('should reorder templates', async () => {
      messageTemplateRepository.reorder.mockReturnValue(Promise.resolve());

      const res = await app.request('/api/message-templates/reorder', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderedIds: ['tpl-2', 'tpl-1'] }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean };
      expect(body.success).toBe(true);
      expect(messageTemplateRepository.reorder).toHaveBeenCalledWith(['tpl-2', 'tpl-1']);
    });

    it('should return 400 when orderedIds is empty', async () => {
      const res = await app.request('/api/message-templates/reorder', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderedIds: [] }),
      });

      expect(res.status).toBe(400);
    });
  });
});
