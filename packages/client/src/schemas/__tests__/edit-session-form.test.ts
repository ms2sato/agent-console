import { describe, it, expect } from 'bun:test';
import * as v from 'valibot';
import { valibotResolver } from '@hookform/resolvers/valibot';
import { EditSessionFormSchema } from '../edit-session-form';

describe('EditSessionFormSchema', () => {
  it('should validate with title only', () => {
    const result = v.safeParse(EditSessionFormSchema, {
      title: 'New Title',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.title).toBe('New Title');
      expect(result.output.branch).toBeUndefined();
    }
  });

  it('should validate with branch only', () => {
    const result = v.safeParse(EditSessionFormSchema, {
      branch: 'feature/new-feature',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.branch).toBe('feature/new-feature');
      expect(result.output.title).toBeUndefined();
    }
  });

  it('should validate with both title and branch', () => {
    const result = v.safeParse(EditSessionFormSchema, {
      title: 'New Title',
      branch: 'feature/new-feature',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.title).toBe('New Title');
      expect(result.output.branch).toBe('feature/new-feature');
    }
  });

  it('should reject empty object (no fields)', () => {
    const result = v.safeParse(EditSessionFormSchema, {});
    expect(result.success).toBe(false);
  });

  it('should reject when both fields are undefined', () => {
    const result = v.safeParse(EditSessionFormSchema, {
      title: undefined,
      branch: undefined,
    });
    expect(result.success).toBe(false);
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

  it('should trim whitespace from branch', () => {
    const result = v.safeParse(EditSessionFormSchema, {
      branch: '  feature/test  ',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.branch).toBe('feature/test');
    }
  });

  it('should reject empty branch name', () => {
    const result = v.safeParse(EditSessionFormSchema, {
      branch: '',
    });
    expect(result.success).toBe(false);
  });

  it('should reject whitespace-only branch name', () => {
    const result = v.safeParse(EditSessionFormSchema, {
      branch: '   ',
    });
    expect(result.success).toBe(false);
  });

  it('should accept valid branch with slashes', () => {
    const result = v.safeParse(EditSessionFormSchema, {
      branch: 'feature/sub/branch',
    });
    expect(result.success).toBe(true);
  });

  it('should accept valid branch with dots', () => {
    const result = v.safeParse(EditSessionFormSchema, {
      branch: 'release-1.2.3',
    });
    expect(result.success).toBe(true);
  });

  it('should accept valid branch with underscores', () => {
    const result = v.safeParse(EditSessionFormSchema, {
      branch: 'feature_branch',
    });
    expect(result.success).toBe(true);
  });

  it('should accept valid branch with hyphens', () => {
    const result = v.safeParse(EditSessionFormSchema, {
      branch: 'feature-branch',
    });
    expect(result.success).toBe(true);
  });

  it('should reject branch with spaces', () => {
    const result = v.safeParse(EditSessionFormSchema, {
      branch: 'feature branch',
    });
    expect(result.success).toBe(false);
  });

  it('should reject branch with special characters', () => {
    const result = v.safeParse(EditSessionFormSchema, {
      branch: 'feature@branch',
    });
    expect(result.success).toBe(false);
  });

  it('should reject branch with unicode characters', () => {
    const result = v.safeParse(EditSessionFormSchema, {
      branch: 'feature/日本語',
    });
    expect(result.success).toBe(false);
  });

  // Type mismatch tests
  it('should reject number for branch field', () => {
    const result = v.safeParse(EditSessionFormSchema, {
      branch: 123,
    });
    expect(result.success).toBe(false);
  });

  it('should reject number for title field', () => {
    const result = v.safeParse(EditSessionFormSchema, {
      title: 456,
    });
    expect(result.success).toBe(false);
  });

  // valibotResolver integration tests
  describe('valibotResolver behavior', () => {
    it('should map v.forward() error to title field when both fields are undefined', async () => {
      const resolver = valibotResolver(EditSessionFormSchema);
      const result = await resolver(
        {},
        undefined,
        { fields: {}, shouldUseNativeValidation: false }
      );

      // With v.forward(), the error should be mapped to the title field
      expect(Object.keys(result.errors).length).toBeGreaterThan(0);
      expect(result.errors.title).toBeDefined();
      expect(result.errors.title?.message).toBe(
        'At least one of title or branch must be provided'
      );
    });

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

    it('should pass validation when branch is provided', async () => {
      const resolver = valibotResolver(EditSessionFormSchema);
      const result = await resolver(
        { branch: 'feature/test' },
        undefined,
        { fields: {}, shouldUseNativeValidation: false }
      );

      expect(Object.keys(result.errors).length).toBe(0);
      expect(result.values).toBeDefined();
    });

    it('should map branch validation error correctly', async () => {
      const resolver = valibotResolver(EditSessionFormSchema);
      const result = await resolver(
        { branch: '' },
        undefined,
        { fields: {}, shouldUseNativeValidation: false }
      );

      expect(result.errors.branch).toBeDefined();
      expect(result.errors.branch?.message).toBe('Branch name cannot be empty');
    });
  });
});
