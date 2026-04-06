import { describe, it, expect } from 'bun:test';
import * as v from 'valibot';
import {
  CreateMessageTemplateRequestSchema,
  UpdateMessageTemplateRequestSchema,
  ReorderMessageTemplatesRequestSchema,
} from '../message-template';

describe('CreateMessageTemplateRequestSchema', () => {
  it('should accept valid input', () => {
    const result = v.safeParse(CreateMessageTemplateRequestSchema, {
      title: 'My Template',
      content: 'Hello world',
    });
    expect(result.success).toBe(true);
  });

  it('should reject empty title', () => {
    const result = v.safeParse(CreateMessageTemplateRequestSchema, {
      title: '',
      content: 'Hello world',
    });
    expect(result.success).toBe(false);
  });

  it('should reject empty content', () => {
    const result = v.safeParse(CreateMessageTemplateRequestSchema, {
      title: 'My Template',
      content: '',
    });
    expect(result.success).toBe(false);
  });

  it('should trim whitespace', () => {
    const result = v.safeParse(CreateMessageTemplateRequestSchema, {
      title: '  My Template  ',
      content: '  Hello world  ',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.title).toBe('My Template');
      expect(result.output.content).toBe('Hello world');
    }
  });
});

describe('UpdateMessageTemplateRequestSchema', () => {
  it('should accept partial updates with title only', () => {
    const result = v.safeParse(UpdateMessageTemplateRequestSchema, {
      title: 'Updated Title',
    });
    expect(result.success).toBe(true);
  });

  it('should accept partial updates with content only', () => {
    const result = v.safeParse(UpdateMessageTemplateRequestSchema, {
      content: 'Updated content',
    });
    expect(result.success).toBe(true);
  });

  it('should reject empty object', () => {
    const result = v.safeParse(UpdateMessageTemplateRequestSchema, {});
    expect(result.success).toBe(false);
  });

  it('should reject empty title string', () => {
    const result = v.safeParse(UpdateMessageTemplateRequestSchema, {
      title: '',
    });
    expect(result.success).toBe(false);
  });
});

describe('ReorderMessageTemplatesRequestSchema', () => {
  it('should accept valid ordered IDs', () => {
    const result = v.safeParse(ReorderMessageTemplatesRequestSchema, {
      orderedIds: ['id-1', 'id-2', 'id-3'],
    });
    expect(result.success).toBe(true);
  });

  it('should reject empty array', () => {
    const result = v.safeParse(ReorderMessageTemplatesRequestSchema, {
      orderedIds: [],
    });
    expect(result.success).toBe(false);
  });
});
