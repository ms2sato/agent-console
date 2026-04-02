/**
 * Centralized worktree-service module mock for tests.
 *
 * IMPORTANT: Import this module in test files that need worktree-service mocking.
 * The mock.module call is executed once when this module is imported.
 * Since Bun's mock.module is process-global, only the FIRST call for a given
 * module path takes effect. This centralized helper ensures all test files
 * share the same mock functions, avoiding conflicts.
 *
 * @example
 * ```typescript
 * import { mockWorktreeService, resetWorktreeServiceMocks } from '../../__tests__/utils/mock-worktree-service-helper.js';
 *
 * beforeEach(() => {
 *   resetWorktreeServiceMocks();
 *   mockWorktreeService.listWorktrees.mockImplementation(() => Promise.resolve([...]));
 * });
 * ```
 */
import { mock, type Mock } from 'bun:test';
import type { HookCommandResult, Worktree } from '@agent-console/shared';

// Type definitions for mock functions
type ListWorktreesFn = (repoPath: string, repoId: string) => Promise<Worktree[]>;
type IsWorktreeOfFn = (repoPath: string, worktreePath: string, repoId: string) => Promise<boolean>;
type CreateWorktreeFn = (
  repoPath: string,
  branch: string,
  repoId: string,
  baseBranch?: string,
) => Promise<{ worktreePath: string; index?: number; error?: string }>;
type RemoveWorktreeFn = (
  repoPath: string,
  path: string,
  force: boolean,
) => Promise<{ success: boolean; error?: string }>;
type ExecuteHookCommandFn = (
  cmd: string,
  cwd: string,
  vars: Record<string, unknown>,
) => Promise<HookCommandResult>;
type GetDefaultBranchFn = (repoPath: string) => Promise<string | null>;

// Exported mock functions - configure these in beforeEach
export const mockWorktreeService = {
  listWorktrees: mock(() => Promise.resolve([] as Worktree[])) as Mock<ListWorktreesFn>,
  isWorktreeOf: mock(() => Promise.resolve(true)) as Mock<IsWorktreeOfFn>,
  createWorktree: mock(() =>
    Promise.resolve({ worktreePath: '' }),
  ) as Mock<CreateWorktreeFn>,
  removeWorktree: mock(() => Promise.resolve({ success: true })) as Mock<RemoveWorktreeFn>,
  executeHookCommand: mock(() =>
    Promise.resolve({ success: true } as HookCommandResult),
  ) as Mock<ExecuteHookCommandFn>,
  getDefaultBranch: mock(() => Promise.resolve('main' as string | null)) as Mock<GetDefaultBranchFn>,
};

// Register mock once at module load time
mock.module('../../services/worktree-service.js', () => ({
  worktreeService: mockWorktreeService,
}));

/**
 * Reset all worktree-service mocks to default implementations.
 * Call this in beforeEach for clean test state.
 */
export function resetWorktreeServiceMocks(): void {
  mockWorktreeService.listWorktrees.mockReset();
  mockWorktreeService.isWorktreeOf.mockReset();
  mockWorktreeService.createWorktree.mockReset();
  mockWorktreeService.removeWorktree.mockReset();
  mockWorktreeService.executeHookCommand.mockReset();
  mockWorktreeService.getDefaultBranch.mockReset();

  // Set default implementations
  mockWorktreeService.listWorktrees.mockImplementation(() => Promise.resolve([]));
  mockWorktreeService.isWorktreeOf.mockImplementation(() => Promise.resolve(true));
  mockWorktreeService.createWorktree.mockImplementation(() =>
    Promise.resolve({ worktreePath: '' }),
  );
  mockWorktreeService.removeWorktree.mockImplementation(() =>
    Promise.resolve({ success: true }),
  );
  mockWorktreeService.executeHookCommand.mockImplementation(() =>
    Promise.resolve({ success: true }),
  );
  mockWorktreeService.getDefaultBranch.mockImplementation(() => Promise.resolve('main'));
}
