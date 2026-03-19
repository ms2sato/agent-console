import { describe, it, expect } from 'bun:test';
import { substituteVariables, type TemplateVariables } from '../template-variables.js';

describe('substituteVariables', () => {
  const defaultVars: TemplateVariables = {
    worktreeNum: 3,
    branch: 'feature-branch',
    repo: 'my-repo',
    worktreePath: '/home/user/repos/my-repo/worktrees/wt-003',
  };

  describe('simple substitutions', () => {
    it('replaces {{WORKTREE_NUM}}', () => {
      expect(substituteVariables('num={{WORKTREE_NUM}}', defaultVars)).toBe('num=3');
    });

    it('replaces {{BRANCH}}', () => {
      expect(substituteVariables('branch={{BRANCH}}', defaultVars)).toBe('branch=feature-branch');
    });

    it('replaces {{REPO}}', () => {
      expect(substituteVariables('repo={{REPO}}', defaultVars)).toBe('repo=my-repo');
    });

    it('replaces {{WORKTREE_PATH}}', () => {
      expect(substituteVariables('path={{WORKTREE_PATH}}', defaultVars)).toBe(
        'path=/home/user/repos/my-repo/worktrees/wt-003'
      );
    });
  });

  describe('arithmetic expressions', () => {
    it('handles addition: {{WORKTREE_NUM + 3000}}', () => {
      expect(substituteVariables('port={{WORKTREE_NUM + 3000}}', defaultVars)).toBe('port=3003');
    });

    it('handles multiplication: {{WORKTREE_NUM * 100}}', () => {
      expect(substituteVariables('offset={{WORKTREE_NUM * 100}}', defaultVars)).toBe('offset=300');
    });

    it('handles subtraction: {{WORKTREE_NUM - 1}}', () => {
      expect(substituteVariables('val={{WORKTREE_NUM - 1}}', defaultVars)).toBe('val=2');
    });

    it('handles division with floor: {{WORKTREE_NUM / 2}}', () => {
      expect(substituteVariables('val={{WORKTREE_NUM / 2}}', defaultVars)).toBe('val=1');
    });

    it('handles division by zero safely', () => {
      expect(substituteVariables('val={{WORKTREE_NUM / 0}}', defaultVars)).toBe('val=0');
    });
  });

  describe('passthrough', () => {
    it('returns content unchanged when no placeholders exist', () => {
      const content = 'PORT=8080\nHOST=localhost';
      expect(substituteVariables(content, defaultVars)).toBe(content);
    });
  });

  describe('multiple occurrences', () => {
    it('replaces multiple occurrences of the same variable', () => {
      expect(substituteVariables('{{REPO}}-{{REPO}}', defaultVars)).toBe('my-repo-my-repo');
    });

    it('replaces mixed variables in one string', () => {
      const input = 'PORT={{WORKTREE_NUM + 3000}}\nBRANCH={{BRANCH}}\nREPO={{REPO}}';
      const expected = 'PORT=3003\nBRANCH=feature-branch\nREPO=my-repo';
      expect(substituteVariables(input, defaultVars)).toBe(expected);
    });
  });
});
