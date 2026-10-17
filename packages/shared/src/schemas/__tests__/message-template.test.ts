import { describe, it, expect } from 'bun:test';
import * as v from 'valibot';
import {
  MessageTemplatesResponseSchema,
  CreateMessageTemplateRequestSchema,
  UpdateMessageTemplateRequestSchema,
  ReorderMessageTemplatesRequestSchema,
  MessageTemplateResponseSchema,
  SuccessResponseSchema,
  type MessageTemplate,
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

describe('strict-parse contract (unknown-key rejection)', () => {
  it('CreateMessageTemplateRequestSchema rejects an unknown key', () => {
    const result = v.safeParse(CreateMessageTemplateRequestSchema, {
      title: 'My Template',
      content: 'Hello world',
      unexpectedField: 'leaked',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues.some((i) => i.path?.[0]?.key === 'unexpectedField')).toBe(true);
    }
  });

  it('UpdateMessageTemplateRequestSchema (v.pipe-wrapped) rejects an unknown key', () => {
    const result = v.safeParse(UpdateMessageTemplateRequestSchema, {
      title: 'Updated Title',
      unexpectedField: 'leaked',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.issues)).toContain('unexpectedField');
    }
  });

  it('ReorderMessageTemplatesRequestSchema rejects an unknown key', () => {
    const result = v.safeParse(ReorderMessageTemplatesRequestSchema, {
      orderedIds: ['id-1'],
      unexpectedField: 'leaked',
    });
    expect(result.success).toBe(false);
  });
});

type Assert<T extends true> = T;
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

// Key-set pin. `MessageTemplate` is derived from `MessageTemplateSchema`, so the schema is the
// only place a field is edited; the pin compares `keyof` with an explicit literal union, so a
// field added to (or removed from) the schema alone is a `tsc` failure (TS2344) naming the
// difference. `Assert<Equals<...>>` is the form that fails under drift; a `declare const x: never`
// form would type-check under it.
//
// Measured reach: (`tsc` diagnostics, control clean first): adding a field to, or removing
// one from, `MessageTemplateSchema` fails `_MessageTemplateKeys` (TS2344, and only it). The diagnostic sits
// on the pin's line and does not name the key.
export type _MessageTemplateKeys = Assert<
  Equals<keyof MessageTemplate, 'id' | 'title' | 'content' | 'sortOrder' | 'createdAt' | 'updatedAt'>
>;

describe('MessageTemplatesResponseSchema', () => {
  const template = {
    id: 't1',
    title: 'T',
    content: 'c',
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('accepts an empty list and a stored template', () => {
    expect(v.safeParse(MessageTemplatesResponseSchema, { templates: [] }).success).toBe(true);
    expect(v.safeParse(MessageTemplatesResponseSchema, { templates: [template] }).success).toBe(true);
  });

  it('rejects a non-numeric sortOrder, an extra template field and an extra top-level key', () => {
    expect(v.safeParse(MessageTemplatesResponseSchema, { templates: [{ ...template, sortOrder: '0' }] }).success).toBe(false);
    expect(v.safeParse(MessageTemplatesResponseSchema, { templates: [{ ...template, extra: 1 }] }).success).toBe(false);
    expect(v.safeParse(MessageTemplatesResponseSchema, { templates: [], extra: 1 }).success).toBe(false);
  });
});

describe('MessageTemplateResponseSchema', () => {
  const template = {
    id: 't1',
    title: 'Title',
    content: 'Body',
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('accepts { template }', () => {
    expect(v.safeParse(MessageTemplateResponseSchema, { template }).success).toBe(true);
  });

  it('rejects an extra field on the envelope and on the template', () => {
    expect(v.safeParse(MessageTemplateResponseSchema, { template, extra: 1 }).success).toBe(false);
    expect(v.safeParse(MessageTemplateResponseSchema, { template: { ...template, extra: 1 } }).success).toBe(false);
  });

  it('rejects a dropped template', () => {
    expect(v.safeParse(MessageTemplateResponseSchema, {}).success).toBe(false);
  });
});

describe('SuccessResponseSchema', () => {
  it('accepts { success: true }', () => {
    expect(v.safeParse(SuccessResponseSchema, { success: true }).success).toBe(true);
  });

  it('rejects success: false, an extra field and a dropped field', () => {
    expect(v.safeParse(SuccessResponseSchema, { success: false }).success).toBe(false);
    expect(v.safeParse(SuccessResponseSchema, { success: true, extra: 1 }).success).toBe(false);
    expect(v.safeParse(SuccessResponseSchema, {}).success).toBe(false);
  });
});
