import { describe, it, expect } from 'bun:test';
import * as v from 'valibot';
import { valibotResolver } from '@hookform/resolvers/valibot';
import { EditSessionFormSchema } from '../edit-session-form';

describe('EditSessionFormSchema', () => {
  it('should validate with title', () => {
    const result = v.safeParse(EditSessionFormSchema, {
      title: 'New Title',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.title).toBe('New Title');
    }
  });

  it('should validate with empty object (title is optional)', () => {
    const result = v.safeParse(EditSessionFormSchema, {});
    expect(result.success).toBe(true);
  });

  it('should validate with undefined title', () => {
    const result = v.safeParse(EditSessionFormSchema, {
      title: undefined,
    });
    expect(result.success).toBe(true);
  });

  it('should trim whitespace from title', () => {
    const result = v.safeParse(EditSessionFormSchema, {
      title: '  New Title  ',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.title).toBe('New Title');
    }
  });

  it('should accept empty string title', () => {
    const result = v.safeParse(EditSessionFormSchema, {
      title: '',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.title).toBe('');
    }
  });

  it('should reject number for title field', () => {
    const result = v.safeParse(EditSessionFormSchema, {
      title: 456,
    });
    expect(result.success).toBe(false);
  });

  // valibotResolver integration tests
  describe('valibotResolver behavior', () => {
    it('should pass validation when title is provided', async () => {
      const resolver = valibotResolver(EditSessionFormSchema);
      const result = await resolver(
        { title: 'Test Title' },
        undefined,
        { fields: {}, shouldUseNativeValidation: false }
      );

      expect(Object.keys(result.errors).length).toBe(0);
      expect(result.values).toBeDefined();
    });

    it('should pass validation with empty object', async () => {
      const resolver = valibotResolver(EditSessionFormSchema);
      const result = await resolver(
        {},
        undefined,
        { fields: {}, shouldUseNativeValidation: false }
      );

      expect(Object.keys(result.errors).length).toBe(0);
      expect(result.values).toBeDefined();
    });
  });
});
