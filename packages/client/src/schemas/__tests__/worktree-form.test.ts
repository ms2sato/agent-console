import { describe, it, expect } from 'bun:test';
import * as v from 'valibot';
import { valibotResolver } from '@hookform/resolvers/valibot';
import { CreateWorktreeFormSchema } from '../worktree-form';

describe('CreateWorktreeFormSchema', () => {
  describe('prompt mode', () => {
    it('should validate when prompt mode has initialPrompt', () => {
      const result = v.safeParse(CreateWorktreeFormSchema, {
        branchNameMode: 'prompt',
        initialPrompt: 'Add dark mode feature',
      });
      expect(result.success).toBe(true);
    });

    it('should reject when prompt mode has empty initialPrompt', () => {
      const result = v.safeParse(CreateWorktreeFormSchema, {
        branchNameMode: 'prompt',
        initialPrompt: '',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        // Check that the error is forwarded to initialPrompt field
        expect(result.issues[0]?.message).toBe(
          'Initial prompt is required when using "Generate from prompt" mode'
        );
        expect(result.issues[0]?.path?.[0]?.key).toBe('initialPrompt');
      }
    });

    it('should reject when prompt mode has whitespace-only initialPrompt', () => {
      const result = v.safeParse(CreateWorktreeFormSchema, {
        branchNameMode: 'prompt',
        initialPrompt: '   ',
      });
      expect(result.success).toBe(false);
    });

    it('should reject when prompt mode has no initialPrompt', () => {
      const result = v.safeParse(CreateWorktreeFormSchema, {
        branchNameMode: 'prompt',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('custom mode', () => {
    it('should validate when custom mode has customBranch', () => {
      const result = v.safeParse(CreateWorktreeFormSchema, {
        branchNameMode: 'custom',
        customBranch: 'feature/new-feature',
      });
      expect(result.success).toBe(true);
    });

    it('should reject when custom mode has empty customBranch', () => {
      const result = v.safeParse(CreateWorktreeFormSchema, {
        branchNameMode: 'custom',
        customBranch: '',
      });
      expect(result.success).toBe(false);
    });

    it('should reject when custom mode has no customBranch', () => {
      const result = v.safeParse(CreateWorktreeFormSchema, {
        branchNameMode: 'custom',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('existing mode', () => {
    it('should validate when existing mode has customBranch', () => {
      const result = v.safeParse(CreateWorktreeFormSchema, {
        branchNameMode: 'existing',
        customBranch: 'main',
      });
      expect(result.success).toBe(true);
    });

    it('should reject when existing mode has empty customBranch', () => {
      const result = v.safeParse(CreateWorktreeFormSchema, {
        branchNameMode: 'existing',
        customBranch: '',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('branch name validation', () => {
    it('should accept valid branch names', () => {
      const validBranches = [
        'feature/new-feature',
        'fix/bug-123',
        'release-1.2.3',
        'feature_branch',
        'main',
      ];
      for (const branch of validBranches) {
        const result = v.safeParse(CreateWorktreeFormSchema, {
          branchNameMode: 'custom',
          customBranch: branch,
        });
        expect(result.success).toBe(true);
      }
    });

    it('should reject branch names with spaces', () => {
      const result = v.safeParse(CreateWorktreeFormSchema, {
        branchNameMode: 'custom',
        customBranch: 'feature branch',
      });
      expect(result.success).toBe(false);
    });

    it('should reject branch names with special characters', () => {
      const result = v.safeParse(CreateWorktreeFormSchema, {
        branchNameMode: 'custom',
        customBranch: 'feature@branch',
      });
      expect(result.success).toBe(false);
    });

    it('should reject branch names with Japanese characters', () => {
      const result = v.safeParse(CreateWorktreeFormSchema, {
        branchNameMode: 'custom',
        customBranch: 'feature/日本語',
      });
      expect(result.success).toBe(false);
    });

    it('should trim whitespace from branch names', () => {
      const result = v.safeParse(CreateWorktreeFormSchema, {
        branchNameMode: 'custom',
        customBranch: '  feature/test  ',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output.customBranch).toBe('feature/test');
      }
    });
  });

  describe('v.forward() error path', () => {
    it('should have field path for forwarded v.check() error', () => {
      const result = v.safeParse(CreateWorktreeFormSchema, {
        branchNameMode: 'prompt',
        initialPrompt: '',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        // v.forward() maps the error to the specified field path
        const issue = result.issues[0];
        expect(issue?.path).toBeDefined();
        expect(issue?.path?.[0]?.key).toBe('initialPrompt');
      }
    });

    it('should have customBranch path for custom mode error', () => {
      const result = v.safeParse(CreateWorktreeFormSchema, {
        branchNameMode: 'custom',
        customBranch: '',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.issues[0];
        expect(issue?.path).toBeDefined();
        expect(issue?.path?.[0]?.key).toBe('customBranch');
      }
    });
  });

  describe('valibotResolver behavior', () => {
    it('should map v.forward() error to field in React Hook Form', async () => {
      const resolver = valibotResolver(CreateWorktreeFormSchema);
      const result = await resolver(
        {
          branchNameMode: 'prompt',
          initialPrompt: '',
        },
        undefined,
        { fields: {}, shouldUseNativeValidation: false }
      );

      // With v.forward(), the error should now be mapped to the initialPrompt field
      expect(Object.keys(result.errors).length).toBeGreaterThan(0);
      expect(result.errors.initialPrompt).toBeDefined();
      expect(result.errors.initialPrompt?.message).toBe(
        'Initial prompt is required when using "Generate from prompt" mode'
      );
    });

    it('should map customBranch required error when undefined', async () => {
      const resolver = valibotResolver(CreateWorktreeFormSchema);
      const result = await resolver(
        {
          branchNameMode: 'custom',
          // customBranch is undefined
        },
        undefined,
        { fields: {}, shouldUseNativeValidation: false }
      );

      expect(Object.keys(result.errors).length).toBeGreaterThan(0);
      expect(result.errors.customBranch).toBeDefined();
      expect(result.errors.customBranch?.message).toBe('Branch name is required');
    });

    it('should map customBranch regex error when invalid', async () => {
      const resolver = valibotResolver(CreateWorktreeFormSchema);
      const result = await resolver(
        {
          branchNameMode: 'custom',
          customBranch: 'invalid branch@name',
        },
        undefined,
        { fields: {}, shouldUseNativeValidation: false }
      );

      expect(Object.keys(result.errors).length).toBeGreaterThan(0);
      expect(result.errors.customBranch).toBeDefined();
      expect(result.errors.customBranch?.message).toContain('Invalid branch name');
    });

    it('should pass validation when data is valid', async () => {
      const resolver = valibotResolver(CreateWorktreeFormSchema);
      const result = await resolver(
        {
          branchNameMode: 'prompt',
          initialPrompt: 'Add dark mode feature',
        },
        undefined,
        { fields: {}, shouldUseNativeValidation: false }
      );

      expect(Object.keys(result.errors).length).toBe(0);
      expect(result.values).toBeDefined();
    });
  });
});
