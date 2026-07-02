import { describe, it, expect } from 'bun:test';
import * as v from 'valibot';
import { AppServerMessageSchema } from '@agent-console/shared';
import type { Worker } from '@agent-console/shared';
import type { PersistedWorker } from '../persistence-service.js';
import type { InternalWorker } from '../worker-types.js';
import {
  SessionConverterService,
  type SessionConverterDeps,
  type RepositoryDisplayLookup,
  type SharedAccountLookup,
} from '../session-converter-service.js';
import type { UsernameLookup } from '../username-lookup.js';
import {
  buildPersistedWorktreeSession,
  buildPersistedAgentWorker,
  buildPersistedTerminalWorker,
  buildPersistedGitDiffWorker,
} from '../../__tests__/utils/build-test-data.js';
import { toRepository } from '../../database/mappers.js';
import type { RepositoryRow } from '../../database/schema.js';
import { claudeCodeAgent } from '../agents/claude-code.js';

/**
 * Part E audit: parse REAL server-constructed app-message payloads against the
 * (now strict) AppServerMessageSchema. These objects are produced by the same
 * production serializers the WebSocket handler uses, not hand-built fixtures,
 * so any excess field the server emits would fail parsing here.
 *
 * Payloads are JSON round-tripped to mirror the exact wire boundary (undefined
 * optional keys are dropped, just as JSON.stringify drops them on the socket).
 */
function parseOverWire(message: unknown) {
  const onWire = JSON.parse(JSON.stringify(message));
  return v.safeParse(AppServerMessageSchema, onWire);
}

function makeConverter(): SessionConverterService {
  const repositoryDisplayLookup: RepositoryDisplayLookup = {
    getRepositoryDisplayInfo: (id: string) =>
      id === 'repo-1' ? { name: 'my-repo', path: '/repos/my-repo' } : undefined,
  };
  const sharedAccountLookup: SharedAccountLookup = {
    isSharedUserId: (userId: string) => userId === 'shared-account-uuid',
  };
  const usernameLookup: UsernameLookup = {
    getUsername: (userId: string) => (userId === 'user-1' ? 'alice' : null),
  };
  const deps: SessionConverterDeps = {
    repositoryDisplayLookup,
    sharedAccountLookup,
    usernameLookup,
    // persistedToPublicSession builds workers inline; these are unused here.
    toPublicWorker: (() => {
      throw new Error('unreachable');
    }) as (w: InternalWorker) => Worker,
    toPersistedWorker: (() => {
      throw new Error('unreachable');
    }) as (w: InternalWorker) => PersistedWorker,
    getServerPid: () => 12345,
  };
  return new SessionConverterService(deps);
}

describe('app-sync payloads parse against the strict AppServerMessageSchema', () => {
  const converter = makeConverter();

  const realWorktreeSession = converter.persistedToPublicSession(
    buildPersistedWorktreeSession({
      id: 'ps-1',
      locationPath: '/repos/my-repo/wt-001',
      worktreeId: 'wt-1',
      serverPid: null,
      createdBy: 'user-1',
      workers: [
        buildPersistedAgentWorker({ id: 'pw-1', agentId: 'agent-1', createdAt: '2026-01-01T00:00:00Z' }),
        buildPersistedTerminalWorker({ id: 'pw-2', createdAt: '2026-01-01T00:01:00Z' }),
        buildPersistedGitDiffWorker({ id: 'pw-3', baseCommit: 'abc123', createdAt: '2026-01-01T00:02:00Z' }),
      ],
    }),
  );

  it('sessions-sync with a worktree session + agent/terminal/git-diff workers', () => {
    const message = {
      type: 'sessions-sync',
      sessions: [realWorktreeSession],
      activityStates: [
        { sessionId: 'ps-1', workerId: 'pw-1', activityState: 'idle' as const },
      ],
    };
    const result = parseOverWire(message);
    expect(result.success).toBe(true);
  });

  it('repositories-sync built from the real toRepository mapper', () => {
    const row: RepositoryRow = {
      id: 'repo-1',
      name: 'my-repo',
      path: '/repos/my-repo',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      setup_command: null,
      cleanup_command: null,
      env_vars: null,
      description: 'A repo',
      default_agent_id: null,
    };
    const message = {
      type: 'repositories-sync',
      repositories: [toRepository(row)],
    };
    const result = parseOverWire(message);
    expect(result.success).toBe(true);
  });

  it('agents-sync built from the real built-in Claude Code agent definition', () => {
    const message = {
      type: 'agents-sync',
      agents: [claudeCodeAgent],
    };
    const result = parseOverWire(message);
    expect(result.success).toBe(true);
  });

  it('worktree-creation-completed carries the full public Session without excess-field rejection', () => {
    const message = {
      type: 'worktree-creation-completed',
      taskId: 'task-1',
      worktree: {
        path: '/repos/my-repo/wt-001',
        branch: 'feature/x',
        isMain: false,
        repositoryId: 'repo-1',
        index: 1,
      },
      session: realWorktreeSession,
    };
    const result = parseOverWire(message);
    expect(result.success).toBe(true);
  });
});
