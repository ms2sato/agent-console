import { describe, it, expect } from 'bun:test';
import {
  augmentWorktreeAddPermissionError,
  WORKTREE_ADD_PERMISSION_HINT_HEADER,
} from '../git-error-hints.js';

const REPO_PATH = '/var/lib/agent-console/source-repos/r';
const PERMISSION_STDERR =
  "fatal: cannot lock ref 'refs/heads/x': Unable to create\n" +
  "'/var/lib/agent-console/source-repos/r/.git/refs/heads/x.lock': Permission denied";

describe('augmentWorktreeAddPermissionError', () => {
  it('appends the numbered causes after the verbatim original in multi-user mode', () => {
    const result = augmentWorktreeAddPermissionError(PERMISSION_STDERR, {
      multiUser: true,
      repoPath: REPO_PATH,
    });
    expect(result.startsWith(PERMISSION_STDERR)).toBe(true);
    expect(result).toContain(WORKTREE_ADD_PERMISSION_HINT_HEADER);
    expect(result).toContain('add-multiuser-user.sh');
    expect(result).toContain(`ls -ld '${REPO_PATH}/.git'`);
    expect(result).toContain(`git -C '${REPO_PATH}' config core.sharedRepository group`);
    expect(result).not.toContain('<repo>');
  });

  it('shell-quotes a repoPath containing a space so each command stays one word per operand', () => {
    const result = augmentWorktreeAddPermissionError(PERMISSION_STDERR, {
      multiUser: true,
      repoPath: '/srv/my repo',
    });
    expect(result).toContain("ls -ld '/srv/my repo/.git'");
    expect(result).toContain("chmod -R g+rwX,g+s '/srv/my repo/.git'");
    expect(result).toContain("git -C '/srv/my repo' config --get core.sharedRepository");
    expect(result).toContain("git -C '/srv/my repo' config core.sharedRepository group");
  });

  it('returns the message unchanged in single-user mode', () => {
    expect(
      augmentWorktreeAddPermissionError(PERMISSION_STDERR, { multiUser: false, repoPath: REPO_PATH }),
    ).toBe(PERMISSION_STDERR);
  });

  it('returns a non-matching message unchanged', () => {
    const msg = 'fatal: branch already exists';
    expect(augmentWorktreeAddPermissionError(msg, { multiUser: true, repoPath: REPO_PATH })).toBe(msg);
  });

  it('returns "Permission denied" without "cannot lock ref" unchanged', () => {
    const msg = "fatal: could not create work tree dir '/x': Permission denied";
    expect(augmentWorktreeAddPermissionError(msg, { multiUser: true, repoPath: REPO_PATH })).toBe(msg);
  });

  it('returns an empty string unchanged', () => {
    expect(augmentWorktreeAddPermissionError('', { multiUser: true, repoPath: REPO_PATH })).toBe('');
  });
});
