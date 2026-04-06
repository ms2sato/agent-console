/**
 * Client-Server Boundary Test: Message Templates API
 *
 * Tests the full CRUD round-trip between client API functions and server endpoints.
 * Verifies data integrity across the client-server boundary.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { Hono } from 'hono';
import type { MessageTemplate } from '@agent-console/shared';

// Import test utilities from server package
import {
  createTestApp,
  setupTestEnvironment,
  cleanupTestEnvironment,
} from '@agent-console/server/src/__tests__/test-utils';

// Import the real SQLite repository (full stack test)
import { SqliteMessageTemplateRepository } from '@agent-console/server/src/repositories/sqlite-message-template-repository';
import { initializeDatabase } from '@agent-console/server/src/database/connection';

// Import client API functions
import {
  fetchMessageTemplates,
  createMessageTemplate,
  updateMessageTemplate,
  deleteMessageTemplate,
  reorderMessageTemplates,
} from '@agent-console/client/src/lib/api';

// Import integration test utilities
import { createFetchBridge } from './test-utils';

describe('Client-Server Boundary: Message Templates API', () => {
  let app: Hono;
  let bridge: ReturnType<typeof createFetchBridge>;

  beforeEach(async () => {
    await setupTestEnvironment();

    // Create repository backed by the test in-memory database
    const db = await initializeDatabase(':memory:');
    const messageTemplateRepository = new SqliteMessageTemplateRepository(db);

    app = await createTestApp({ messageTemplateRepository });
    bridge = createFetchBridge(app);
  });

  afterEach(async () => {
    bridge.restore();
    await cleanupTestEnvironment();
  });

  it('POST then GET round-trip: created template appears in list', async () => {
    // Create via client API
    const createResult = await createMessageTemplate('Greeting', 'Hello world');
    expect(createResult.template).toBeDefined();
    expect(createResult.template.title).toBe('Greeting');
    expect(createResult.template.content).toBe('Hello world');

    // Fetch via client API
    const listResult = await fetchMessageTemplates();
    expect(listResult.templates).toHaveLength(1);
    expect(listResult.templates[0].title).toBe('Greeting');
    expect(listResult.templates[0].content).toBe('Hello world');
    expect(listResult.templates[0].id).toBe(createResult.template.id);
  });

  it('PUT updates template and GET reflects changes', async () => {
    // Create
    const { template } = await createMessageTemplate('Original', 'original content');

    // Update via client API
    const updateResult = await updateMessageTemplate(template.id, {
      title: 'Updated',
      content: 'updated content',
    });
    expect(updateResult.template.title).toBe('Updated');
    expect(updateResult.template.content).toBe('updated content');

    // Verify via GET
    const listResult = await fetchMessageTemplates();
    expect(listResult.templates).toHaveLength(1);
    expect(listResult.templates[0].title).toBe('Updated');
    expect(listResult.templates[0].content).toBe('updated content');
  });

  it('DELETE removes template from list', async () => {
    // Create two templates
    await createMessageTemplate('First', 'first');
    const { template: second } = await createMessageTemplate('Second', 'second');

    // Delete the second
    const deleteResult = await deleteMessageTemplate(second.id);
    expect(deleteResult.success).toBe(true);

    // Verify only first remains
    const listResult = await fetchMessageTemplates();
    expect(listResult.templates).toHaveLength(1);
    expect(listResult.templates[0].title).toBe('First');
  });

  it('reorder changes sort_order in GET response', async () => {
    // Create three templates
    const { template: a } = await createMessageTemplate('A', 'a');
    const { template: b } = await createMessageTemplate('B', 'b');
    const { template: c } = await createMessageTemplate('C', 'c');

    // Reorder: C, A, B
    const reorderResult = await reorderMessageTemplates([c.id, a.id, b.id]);
    expect(reorderResult.success).toBe(true);

    // Verify order
    const listResult = await fetchMessageTemplates();
    expect(listResult.templates).toHaveLength(3);
    expect(listResult.templates[0].title).toBe('C');
    expect(listResult.templates[1].title).toBe('A');
    expect(listResult.templates[2].title).toBe('B');
  });

  it('POST with empty title returns validation error', async () => {
    await expect(
      createMessageTemplate('', 'some content'),
    ).rejects.toThrow();
  });

  it('POST with empty content returns validation error', async () => {
    await expect(
      createMessageTemplate('Valid Title', ''),
    ).rejects.toThrow();
  });
});
