import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { Kysely } from 'kysely';
import type { Database } from '../../database/schema.js';
import { createDatabaseForTest } from '../../database/connection.js';
import { SqliteMessageTemplateRepository } from '../sqlite-message-template-repository.js';

describe('SqliteMessageTemplateRepository', () => {
  let db: Kysely<Database>;
  let repository: SqliteMessageTemplateRepository;

  beforeEach(async () => {
    db = await createDatabaseForTest();
    repository = new SqliteMessageTemplateRepository(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe('findAll', () => {
    it('should return empty array on fresh database', async () => {
      const results = await repository.findAll();
      expect(results).toEqual([]);
    });

    it('should return templates ordered by sort_order ascending', async () => {
      await repository.create('tpl-b', 'B Template', 'content-b', 2);
      await repository.create('tpl-a', 'A Template', 'content-a', 0);
      await repository.create('tpl-c', 'C Template', 'content-c', 1);

      const results = await repository.findAll();
      expect(results).toHaveLength(3);
      expect(results[0].id).toBe('tpl-a');
      expect(results[1].id).toBe('tpl-c');
      expect(results[2].id).toBe('tpl-b');
    });
  });

  describe('findById', () => {
    it('should return null for non-existent id', async () => {
      const result = await repository.findById('non-existent');
      expect(result).toBeNull();
    });

    it('should find existing template', async () => {
      await repository.create('tpl-1', 'My Template', 'My content', 0);

      const result = await repository.findById('tpl-1');
      expect(result).not.toBeNull();
      expect(result!.id).toBe('tpl-1');
      expect(result!.title).toBe('My Template');
      expect(result!.content).toBe('My content');
      expect(result!.sortOrder).toBe(0);
      expect(result!.createdAt).toBeDefined();
      expect(result!.updatedAt).toBeDefined();
    });
  });

  describe('create', () => {
    it('should create and return a template', async () => {
      const template = await repository.create('tpl-1', 'Title', 'Content', 5);

      expect(template.id).toBe('tpl-1');
      expect(template.title).toBe('Title');
      expect(template.content).toBe('Content');
      expect(template.sortOrder).toBe(5);
      expect(template.createdAt).toBeDefined();
      expect(template.updatedAt).toBeDefined();
    });
  });

  describe('update', () => {
    it('should update title', async () => {
      await repository.create('tpl-1', 'Original', 'Content', 0);

      const updated = await repository.update('tpl-1', { title: 'Updated Title' });
      expect(updated).not.toBeNull();
      expect(updated!.title).toBe('Updated Title');
      expect(updated!.content).toBe('Content');
    });

    it('should update content', async () => {
      await repository.create('tpl-1', 'Title', 'Original Content', 0);

      const updated = await repository.update('tpl-1', { content: 'New Content' });
      expect(updated).not.toBeNull();
      expect(updated!.content).toBe('New Content');
      expect(updated!.title).toBe('Title');
    });

    it('should update both title and content', async () => {
      await repository.create('tpl-1', 'Old Title', 'Old Content', 0);

      const updated = await repository.update('tpl-1', { title: 'New Title', content: 'New Content' });
      expect(updated).not.toBeNull();
      expect(updated!.title).toBe('New Title');
      expect(updated!.content).toBe('New Content');
    });

    it('should update the updatedAt timestamp', async () => {
      const created = await repository.create('tpl-1', 'Title', 'Content', 0);
      // Small delay to ensure timestamp difference
      await new Promise((r) => setTimeout(r, 10));

      const updated = await repository.update('tpl-1', { title: 'New Title' });
      expect(updated!.updatedAt).not.toBe(created.updatedAt);
    });

    it('should return null for non-existent id', async () => {
      const result = await repository.update('non-existent', { title: 'Updated' });
      expect(result).toBeNull();
    });
  });

  describe('delete', () => {
    it('should delete an existing template and return true', async () => {
      await repository.create('tpl-1', 'Title', 'Content', 0);

      const deleted = await repository.delete('tpl-1');
      expect(deleted).toBe(true);

      const remaining = await repository.findAll();
      expect(remaining).toHaveLength(0);
    });

    it('should return false for non-existent id', async () => {
      const deleted = await repository.delete('non-existent');
      expect(deleted).toBe(false);
    });
  });

  describe('reorder', () => {
    it('should update sort_order based on array position', async () => {
      await repository.create('tpl-a', 'A', 'a', 0);
      await repository.create('tpl-b', 'B', 'b', 1);
      await repository.create('tpl-c', 'C', 'c', 2);

      // Reverse the order
      await repository.reorder(['tpl-c', 'tpl-b', 'tpl-a']);

      const results = await repository.findAll();
      expect(results[0].id).toBe('tpl-c');
      expect(results[0].sortOrder).toBe(0);
      expect(results[1].id).toBe('tpl-b');
      expect(results[1].sortOrder).toBe(1);
      expect(results[2].id).toBe('tpl-a');
      expect(results[2].sortOrder).toBe(2);
    });

    it('should reject partial reorder (subset of IDs)', async () => {
      await repository.create('tpl-a', 'A', 'a', 0);
      await repository.create('tpl-b', 'B', 'b', 1);
      await repository.create('tpl-c', 'C', 'c', 2);

      await expect(repository.reorder(['tpl-b', 'tpl-a'])).rejects.toThrow(
        'orderedIds must contain each message template exactly once',
      );
    });

    it('should reject duplicate IDs', async () => {
      await repository.create('tpl-a', 'A', 'a', 0);
      await repository.create('tpl-b', 'B', 'b', 1);

      await expect(repository.reorder(['tpl-a', 'tpl-a'])).rejects.toThrow(
        'orderedIds must contain each message template exactly once',
      );
    });
  });
});
