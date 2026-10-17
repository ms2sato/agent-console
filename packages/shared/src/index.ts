export * from './types/auth.js';
export * from './types/worker.js';
export * from './types/embedded-agent.js';
export * from './types/embedded-agent-slash-commands.js';
export * from './agent-surface/agent-surface.js';
export * from './types/agent-operations.js';
export * from './agent-surface/agent-parameter-capabilities.js';
export * from './types/embedded-agent-parameter-capabilities.js';
export * from './types/session.js';
export * from './types/repository.js';
export * from './types/worktree-deletion.js';
export * from './types/worktree-pull.js';
export * from './types/git-diff.js';
export * from './types/job.js';
export * from './types/integration.js';
export * from './types/notification.js';
export * from './types/notification-item.js';
export * from './types/system-events.js';
export * from './types/timer.js';
export * from './types/conditional-wakeup.js';
export * from './types/interactive-process.js';
export * from './types/message-contracts.js';
export * from './types/todo.js';
export * from './utils/ndjson-lines.js';
export * from './utils/agent-capabilities.js';
export * from './utils/worker-predicates.js';
export * from './schemas/index.js';
export * from './constants/index.js';
export * from './schema-version.gen.js';

export interface ApiError {
  error: string;
  message: string;
}
