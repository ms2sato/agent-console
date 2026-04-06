import { Hono } from 'hono';
import type { AppBindings } from '../app-context.js';
import { vValidator } from '../middleware/validation.js';
import {
  CreateMessageTemplateRequestSchema,
  UpdateMessageTemplateRequestSchema,
  ReorderMessageTemplatesRequestSchema,
} from '@agent-console/shared';
import { NotFoundError } from '../lib/errors.js';

const messageTemplates = new Hono<AppBindings>()
  // Get all message templates
  .get('/', async (c) => {
    const { messageTemplateRepository } = c.get('appContext');
    const templates = await messageTemplateRepository.findAll();
    return c.json({ templates });
  })
  // Create a new message template
  .post('/', vValidator(CreateMessageTemplateRequestSchema), async (c) => {
    const body = c.req.valid('json');
    const { messageTemplateRepository } = c.get('appContext');

    // Determine next sort order based on existing templates
    const existing = await messageTemplateRepository.findAll();
    const maxSortOrder = existing.length > 0
      ? Math.max(...existing.map((t) => t.sortOrder))
      : -1;

    const template = await messageTemplateRepository.create(
      crypto.randomUUID(),
      body.title,
      body.content,
      maxSortOrder + 1,
    );
    return c.json({ template }, 201);
  })
  // Reorder message templates (must be before /:id to avoid matching "reorder" as an id)
  .put('/reorder', vValidator(ReorderMessageTemplatesRequestSchema), async (c) => {
    const body = c.req.valid('json');
    const { messageTemplateRepository } = c.get('appContext');
    await messageTemplateRepository.reorder(body.orderedIds);
    return c.json({ success: true });
  })
  // Update a message template
  .put('/:id', vValidator(UpdateMessageTemplateRequestSchema), async (c) => {
    const id = c.req.param('id');
    const body = c.req.valid('json');
    const { messageTemplateRepository } = c.get('appContext');
    const template = await messageTemplateRepository.update(id, body);
    if (!template) {
      throw new NotFoundError('Message template');
    }
    return c.json({ template });
  })
  // Delete a message template
  .delete('/:id', async (c) => {
    const id = c.req.param('id');
    const { messageTemplateRepository } = c.get('appContext');
    const deleted = await messageTemplateRepository.delete(id);
    if (!deleted) {
      throw new NotFoundError('Message template');
    }
    return c.json({ success: true });
  });

export { messageTemplates };
