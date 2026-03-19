/**
 * Template variable substitution for worktree configuration.
 *
 * Supports: {{WORKTREE_NUM}}, {{BRANCH}}, {{REPO}}, {{WORKTREE_PATH}}
 * Also supports arithmetic: {{WORKTREE_NUM + 3000}}, {{WORKTREE_NUM * 100}}, etc.
 *
 * SECURITY NOTE: The variables (branch, repo) come from git which enforces
 * strict naming rules. Git branch names cannot contain shell metacharacters
 * like ;, |, &, etc., so command injection via these values is not possible.
 * See: https://git-scm.com/docs/git-check-ref-format
 */

export interface TemplateVariables {
  worktreeNum: number;
  branch: string;
  repo: string;
  worktreePath: string;
}

export function substituteVariables(content: string, vars: TemplateVariables): string {
  // Handle arithmetic expressions like {{WORKTREE_NUM + 3000}}
  content = content.replace(/\{\{WORKTREE_NUM\s*([+\-*/])\s*(\d+)\}\}/g, (_match, op, num) => {
    const n = parseInt(num, 10);
    switch (op) {
      case '+': return String(vars.worktreeNum + n);
      case '-': return String(vars.worktreeNum - n);
      case '*': return String(vars.worktreeNum * n);
      case '/': return String(Math.floor(vars.worktreeNum / n));
      default: return String(vars.worktreeNum);
    }
  });

  // Simple substitutions
  content = content.replace(/\{\{WORKTREE_NUM\}\}/g, String(vars.worktreeNum));
  content = content.replace(/\{\{BRANCH\}\}/g, vars.branch);
  content = content.replace(/\{\{REPO\}\}/g, vars.repo);
  content = content.replace(/\{\{WORKTREE_PATH\}\}/g, vars.worktreePath);

  return content;
}
