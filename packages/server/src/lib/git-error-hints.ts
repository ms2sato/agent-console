export const WORKTREE_ADD_PERMISSION_HINT_HEADER = 'Possible causes (multi-user mode):';

// The real stderr spans two lines (the ref name, then the lock path), so the
// pattern must cross a newline.
const WORKTREE_ADD_PERMISSION_PATTERN = /cannot lock ref[\s\S]*Permission denied/;

/**
 * Append multi-user setup hints to a `git worktree add` failure message that
 * matches the `cannot lock ref ... Permission denied` shape. The original
 * message is kept verbatim at the start. Pure: the caller decides whether the
 * server runs in multi-user mode.
 */
export function augmentWorktreeAddPermissionError(
  message: string,
  opts: { multiUser: boolean; repoPath: string },
): string {
  if (!opts.multiUser || !WORKTREE_ADD_PERMISSION_PATTERN.test(message)) {
    return message;
  }
  const { repoPath } = opts;
  const hint = [
    WORKTREE_ADD_PERMISSION_HINT_HEADER,
    '',
    "1. (Most common) Your OS user is not in the shared group ('agent-console-users').",
    '     Fix (as root): scripts/add-multiuser-user.sh <username>',
    '     Then log in again: group membership is resolved at login, so retrying from the same open session still fails.',
    '',
    `2. The repository's .git directory lacks group-write and setgid bits.`,
    `     Verify: ls -ld ${repoPath}/.git   (expect: drwxrws---, group 'agent-console-users')`,
    `     Fix (as root): chmod -R g+rwX,g+s ${repoPath}/.git`,
    '',
    '3. core.sharedRepository=group is not set on the repository.',
    `     Verify: git -C ${repoPath} config --get core.sharedRepository`,
    `     Fix:    git -C ${repoPath} config core.sharedRepository group`,
  ].join('\n');
  return `${message}\n\n${hint}`;
}
