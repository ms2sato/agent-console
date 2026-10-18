/**
 * Wire-consumption fixtures for the app WebSocket: one real-shaped frame per
 * `AppServerMessage['type']`, fed through the REAL entry point (the mock
 * socket -> `app-websocket`'s strict envelope parse -> the `useAppWsEvent`
 * dispatcher) and asserting the observable consequence.
 *
 * `CASES` is a `Record<AppServerMessage['type'], ...>`, so adding a message
 * type to the union without adding a fixture here is a TYPE ERROR -- the
 * dispatch layer cannot silently grow a type nobody tests (the #959 PR-C
 * silent drop). A type that is deliberately a no-op is still listed, with the
 * reason and an assertion that no callback fired.
 *
 * What this does NOT cover (stays with E2E + review): guard-logic semantics
 * inside a handler.
 */
import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import type { AppServerMessage } from '@agent-console/shared';
import { useAppWsEvent } from '../useAppWs';
import { _reset as resetWebSocket } from '../../lib/app-websocket';
import { MockWebSocket, installMockWebSocket } from '../../test/mock-websocket';

// The options type is not exported from the hook; derive it rather than widen production's surface for a test.
type UseAppWsEventOptions = NonNullable<Parameters<typeof useAppWsEvent>[0]>;
type CallbackName = keyof UseAppWsEventOptions;

interface WireCase {
  /** A real-shaped frame: it must pass the strict envelope parse. */
  frame: Record<string, unknown>;
  /** The one callback this frame must reach, with the exact arguments; `null` = deliberate no-op. */
  expects: { callback: CallbackName; args: unknown[] } | null;
  /** Required when `expects` is null: why nothing is dispatched. */
  noOpReason?: string;
}

const quickSession = {
  id: 'session-1',
  type: 'quick',
  locationPath: '/path/1',
  status: 'active',
  activationState: 'running',
  createdAt: '2024-01-01',
  workers: [],
  isShared: false,
  recoveryState: 'healthy',
};
const hibernatedSession = {
  ...quickSession,
  status: 'inactive',
  activationState: 'hibernated',
  pausedAt: '2026-01-01T00:00:00.000Z',
};
const activityStates = [{ sessionId: 'session-1', workerId: 'worker-1', activityState: 'active' }];
const agent = {
  id: 'agent-1',
  name: 'Agent',
  commandTemplate: 'agent {{prompt}}',
  isBuiltIn: false,
  createdAt: '2024-01-01',
  capabilities: { supportsContinue: false, supportsHeadlessMode: false, supportsActivityDetection: false },
};
const embeddedAgent = {
  id: 'embedded-agent-1',
  name: 'Local GPT',
  engine: 'openai-api',
  provider: { baseUrl: 'https://api.example.com/v1', model: 'gpt-4o' },
  isBuiltIn: false,
  createdBy: 'alice',
  createdAt: '2024-01-01',
  updatedAt: '2024-01-01',
};
const repository = {
  id: 'repo-1',
  name: 'repo',
  path: '/repos/repo',
  createdAt: '2024-01-01',
  orchestratorSessionIds: [],
  clonedSourceRepoPath: null,
};
const worktree = { path: '/repos/repo/wt-1', branch: 'feature', isMain: false, repositoryId: 'repo-1', index: 1 };
const workerMessage = {
  id: 'msg-1',
  sessionId: 'session-1',
  fromWorkerId: 'worker-1',
  fromWorkerName: 'Worker 1',
  toWorkerId: 'worker-2',
  toWorkerName: 'Worker 2',
  content: 'hello',
  timestamp: '2026-01-01T00:00:00.000Z',
};
const inboundEvent = { type: 'ci:completed', source: 'github', summary: 'CI passed', metadata: { branch: 'main' } };

const worktreeCreationCompleted = { type: 'worktree-creation-completed', taskId: 'task-1', worktree, session: null };
const worktreeCreationFailed = { type: 'worktree-creation-failed', taskId: 'task-1', error: 'boom' };
const worktreeDeletionCompleted = { type: 'worktree-deletion-completed', taskId: 'task-1', sessionIds: ['session-1'] };
const worktreeDeletionFailed = { type: 'worktree-deletion-failed', taskId: 'task-1', sessionIds: ['session-1'], error: 'boom' };
const worktreePullCompleted = { type: 'worktree-pull-completed', taskId: 'task-1', worktreePath: '/p', branch: 'main', commitsPulled: 3 };
const worktreePullFailed = { type: 'worktree-pull-failed', taskId: 'task-1', worktreePath: '/p', error: 'boom' };

const CASES: Record<AppServerMessage['type'], WireCase> = {
  'sessions-sync': {
    frame: { type: 'sessions-sync', sessions: [quickSession], activityStates },
    expects: { callback: 'onSessionsSync', args: [[quickSession], activityStates] },
  },
  'session-created': {
    frame: { type: 'session-created', session: quickSession },
    expects: { callback: 'onSessionCreated', args: [quickSession] },
  },
  'session-updated': {
    frame: { type: 'session-updated', session: quickSession },
    expects: { callback: 'onSessionUpdated', args: [quickSession] },
  },
  'session-deleted': {
    frame: { type: 'session-deleted', sessionId: 'session-1' },
    expects: { callback: 'onSessionDeleted', args: ['session-1'] },
  },
  'session-paused': {
    frame: { type: 'session-paused', session: hibernatedSession },
    expects: { callback: 'onSessionPaused', args: [hibernatedSession] },
  },
  'session-resumed': {
    frame: { type: 'session-resumed', session: quickSession, activityStates },
    expects: { callback: 'onSessionResumed', args: [quickSession, activityStates] },
  },
  'worker-activity': {
    frame: { type: 'worker-activity', sessionId: 'session-1', workerId: 'worker-1', activityState: 'idle' },
    expects: { callback: 'onWorkerActivity', args: ['session-1', 'worker-1', 'idle'] },
  },
  'worker-activated': {
    frame: { type: 'worker-activated', sessionId: 'session-1', workerId: 'worker-1' },
    expects: null,
    noOpReason: 'the server always follows worker-activated with a session-updated that carries the activation change',
  },
  'worker-restarted': {
    frame: { type: 'worker-restarted', sessionId: 'session-1', workerId: 'worker-1', activityState: 'idle' },
    expects: { callback: 'onWorkerRestarted', args: ['session-1', 'worker-1', 'idle'] },
  },
  'agents-sync': {
    frame: { type: 'agents-sync', agents: [agent] },
    expects: { callback: 'onAgentsSync', args: [[agent]] },
  },
  'agent-created': {
    frame: { type: 'agent-created', agent },
    expects: { callback: 'onAgentCreated', args: [agent] },
  },
  'agent-updated': {
    frame: { type: 'agent-updated', agent },
    expects: { callback: 'onAgentUpdated', args: [agent] },
  },
  'agent-deleted': {
    frame: { type: 'agent-deleted', agentId: 'agent-1' },
    expects: { callback: 'onAgentDeleted', args: ['agent-1'] },
  },
  'embedded-agent-created': {
    frame: { type: 'embedded-agent-created', embeddedAgent },
    expects: { callback: 'onEmbeddedAgentCreated', args: [embeddedAgent] },
  },
  'embedded-agent-updated': {
    frame: { type: 'embedded-agent-updated', embeddedAgent },
    expects: { callback: 'onEmbeddedAgentUpdated', args: [embeddedAgent] },
  },
  'embedded-agent-deleted': {
    frame: { type: 'embedded-agent-deleted', embeddedAgentId: 'embedded-agent-1' },
    expects: { callback: 'onEmbeddedAgentDeleted', args: ['embedded-agent-1'] },
  },
  'repositories-sync': {
    frame: { type: 'repositories-sync', repositories: [repository] },
    expects: { callback: 'onRepositoriesSync', args: [[repository]] },
  },
  'repository-created': {
    frame: { type: 'repository-created', repository },
    expects: { callback: 'onRepositoryCreated', args: [repository] },
  },
  'repository-updated': {
    frame: { type: 'repository-updated', repository },
    expects: { callback: 'onRepositoryUpdated', args: [repository] },
  },
  'repository-deleted': {
    frame: { type: 'repository-deleted', repositoryId: 'repo-1' },
    expects: { callback: 'onRepositoryDeleted', args: ['repo-1'] },
  },
  'worktree-creation-completed': {
    frame: worktreeCreationCompleted,
    expects: { callback: 'onWorktreeCreationCompleted', args: [worktreeCreationCompleted] },
  },
  'worktree-creation-failed': {
    frame: worktreeCreationFailed,
    expects: { callback: 'onWorktreeCreationFailed', args: [worktreeCreationFailed] },
  },
  'worktree-deletion-completed': {
    frame: worktreeDeletionCompleted,
    expects: { callback: 'onWorktreeDeletionCompleted', args: [worktreeDeletionCompleted] },
  },
  'worktree-deletion-failed': {
    frame: worktreeDeletionFailed,
    expects: { callback: 'onWorktreeDeletionFailed', args: [worktreeDeletionFailed] },
  },
  'worktree-pull-completed': {
    frame: worktreePullCompleted,
    expects: { callback: 'onWorktreePullCompleted', args: [worktreePullCompleted] },
  },
  'worktree-pull-failed': {
    frame: worktreePullFailed,
    expects: { callback: 'onWorktreePullFailed', args: [worktreePullFailed] },
  },
  'worker-message': {
    frame: { type: 'worker-message', message: workerMessage },
    expects: { callback: 'onWorkerMessage', args: [workerMessage] },
  },
  'inbound-event': {
    frame: { type: 'inbound-event', sessionId: 'session-1', event: inboundEvent },
    expects: { callback: 'onInboundEvent', args: ['session-1', inboundEvent] },
  },
  'memo-updated': {
    frame: { type: 'memo-updated', sessionId: 'session-1', content: 'notes' },
    expects: { callback: 'onMemoUpdated', args: ['session-1', 'notes'] },
  },
  'review-queue-updated': {
    frame: { type: 'review-queue-updated' },
    expects: { callback: 'onReviewQueueUpdated', args: [] },
  },
  'artifact-created': {
    frame: { type: 'artifact-created', sessionId: 'session-1', artifactId: 'artifact-1' },
    expects: { callback: 'onArtifactCreated', args: ['session-1', 'artifact-1'] },
  },
  'artifact-updated': {
    frame: { type: 'artifact-updated', sessionId: 'session-1', artifactId: 'artifact-1' },
    expects: { callback: 'onArtifactUpdated', args: ['session-1', 'artifact-1'] },
  },
  'artifact-deleted': {
    frame: { type: 'artifact-deleted', sessionId: 'session-1', artifactId: 'artifact-1' },
    expects: { callback: 'onArtifactDeleted', args: ['session-1', 'artifact-1'] },
  },
  'bookmark-created': {
    frame: { type: 'bookmark-created', sessionId: 'session-1', bookmarkId: 'bookmark-1' },
    expects: { callback: 'onBookmarkCreated', args: ['session-1', 'bookmark-1'] },
  },
  'bookmark-deleted': {
    frame: { type: 'bookmark-deleted', sessionId: 'session-1', bookmarkId: 'bookmark-1' },
    expects: { callback: 'onBookmarkDeleted', args: ['session-1', 'bookmark-1'] },
  },
  'todos-updated': {
    frame: { type: 'todos-updated', sessionId: 'session-1' },
    expects: { callback: 'onTodosUpdated', args: ['session-1'] },
  },
  'orchestrator-designation-changed': {
    frame: {
      type: 'orchestrator-designation-changed',
      repositoryId: 'repo-1',
      orchestratorSessionIds: ['session-1'],
      changedSessionId: 'session-1',
      action: 'added',
    },
    expects: { callback: 'onOrchestratorDesignationChanged', args: ['repo-1', ['session-1'], 'session-1', 'added'] },
  },
  'schema-version': {
    frame: { type: 'schema-version', version: 'any-version' },
    expects: null,
    noOpReason: 'intercepted by app-websocket before the envelope parse and never forwarded to message listeners (version mismatch is handled there)',
  },
};

/** Every callback any case expects; each gets a mock so "no OTHER callback fired" is checkable. */
const ALL_CALLBACKS: CallbackName[] = [
  ...new Set(Object.values(CASES).flatMap((c) => (c.expects ? [c.expects.callback] : []))),
];

describe('useAppWsEvent wire consumption (one real frame per AppServerMessage type)', () => {
  let restoreWebSocket: () => void;
  let originalLocation: Location;
  let consoleSpies: Array<ReturnType<typeof spyOn>>;

  beforeEach(() => {
    originalLocation = window.location;
    restoreWebSocket = installMockWebSocket();
    Object.defineProperty(window, 'location', {
      value: { protocol: 'http:', host: 'localhost:3000' },
      writable: true,
    });
    consoleSpies = [
      spyOn(console, 'log').mockImplementation(() => {}),
      spyOn(console, 'error').mockImplementation(() => {}),
    ];
    resetWebSocket();
  });

  afterEach(() => {
    restoreWebSocket();
    Object.defineProperty(window, 'location', { value: originalLocation, writable: true });
    for (const spy of consoleSpies) spy.mockRestore();
  });

  it.each(Object.entries(CASES))('%s reaches the dispatcher with its payload', (type, wireCase) => {
    const mocks = Object.fromEntries(ALL_CALLBACKS.map((name) => [name, mock(() => {})])) as Record<
      CallbackName,
      ReturnType<typeof mock>
    >;
    renderHook(() => useAppWsEvent(mocks as unknown as UseAppWsEventOptions));
    const ws = MockWebSocket.getLastInstance();

    act(() => {
      ws?.simulateOpen();
      ws?.simulateMessage(JSON.stringify(wireCase.frame));
    });

    expect(wireCase.frame.type).toBe(type);
    if (wireCase.expects === null) {
      expect(wireCase.noOpReason).toBeTruthy();
      for (const name of ALL_CALLBACKS) expect(mocks[name]).not.toHaveBeenCalled();
      return;
    }
    const { callback, args } = wireCase.expects;
    expect(mocks[callback]).toHaveBeenCalledTimes(1);
    expect(mocks[callback]).toHaveBeenCalledWith(...args);
    for (const name of ALL_CALLBACKS) {
      if (name !== callback) expect(mocks[name]).not.toHaveBeenCalled();
    }
  });
});

describe('useAppWsEvent wire consumption (todos-updated with a null session)', () => {
  let restoreWebSocket: () => void;
  let originalLocation: Location;

  beforeEach(() => {
    originalLocation = window.location;
    restoreWebSocket = installMockWebSocket();
    Object.defineProperty(window, 'location', {
      value: { protocol: 'http:', host: 'localhost:3000' },
      writable: true,
    });
    resetWebSocket();
  });

  afterEach(() => {
    restoreWebSocket();
    Object.defineProperty(window, 'location', { value: originalLocation, writable: true });
  });

  it('a todos-updated frame with sessionId null reaches onTodosUpdated as null', () => {
    const onTodosUpdated = mock(() => {});
    renderHook(() => useAppWsEvent({ onTodosUpdated, invalidateOnReconnect: [['test-family']] }));
    const ws = MockWebSocket.getLastInstance();

    act(() => {
      ws?.simulateOpen();
      ws?.simulateMessage(JSON.stringify({ type: 'todos-updated', sessionId: null }));
    });

    expect(onTodosUpdated).toHaveBeenCalledTimes(1);
    expect(onTodosUpdated).toHaveBeenCalledWith(null);
  });
});

/**
 * The entity types the dispatcher hands to its callbacks (`Session`,
 * `Worker`, `Repository`) are derived from the wire schemas, so the fullest
 * real-shaped entity -- every optional field populated, a nullable carrying
 * null, the widest worker variant -- must survive the real parse and reach
 * the callback unchanged.
 */
describe('useAppWsEvent wire consumption (fully populated derived entities)', () => {
  let restoreWebSocket: () => void;
  let originalLocation: Location;
  let consoleSpies: Array<ReturnType<typeof spyOn>>;

  beforeEach(() => {
    originalLocation = window.location;
    restoreWebSocket = installMockWebSocket();
    Object.defineProperty(window, 'location', {
      value: { protocol: 'http:', host: 'localhost:3000' },
      writable: true,
    });
    consoleSpies = [
      spyOn(console, 'log').mockImplementation(() => {}),
      spyOn(console, 'error').mockImplementation(() => {}),
    ];
    resetWebSocket();
  });

  afterEach(() => {
    restoreWebSocket();
    Object.defineProperty(window, 'location', { value: originalLocation, writable: true });
    for (const spy of consoleSpies) spy.mockRestore();
  });

  const fullWorktreeSession = {
    id: 'session-full',
    type: 'worktree',
    locationPath: '/repos/repo/wt-1',
    status: 'active',
    activationState: 'running',
    createdAt: '2024-01-01',
    workers: [
      {
        id: 'worker-e',
        name: 'Embedded',
        createdAt: '2024-01-01',
        type: 'embedded-agent',
        embeddedAgentId: 'embedded-agent-1',
        activated: true,
        autoCompaction: true,
        contextWindowTokens: 128000,
        model: 'gpt-4o',
        reasoningEffort: null,
        hasParameterOverride: false,
        mcpServers: [{ name: 'srv', scope: 'project', hash: 'h', decision: 'allowed', status: 'connected' }],
      },
    ],
    initialPrompt: 'do it',
    initialPromptDelivered: true,
    title: 'Title',
    pausedAt: '2026-01-01T00:00:00.000Z',
    parentSessionId: 'session-parent',
    parentWorkerId: 'worker-parent',
    createdBy: 'user-1',
    createdByUsername: null,
    initiatedBy: 'user-2',
    isShared: true,
    recoveryState: 'orphaned',
    repositoryId: 'repo-1',
    repositoryName: 'repo',
    worktreeId: 'feature',
    isMainWorktree: false,
  };

  it('session-created: a fully populated worktree session with an embedded-agent worker reaches onSessionCreated unchanged', () => {
    const onSessionCreated = mock(() => {});
    renderHook(() => useAppWsEvent({ onSessionCreated }));
    const ws = MockWebSocket.getLastInstance();

    act(() => {
      ws?.simulateOpen();
      ws?.simulateMessage(JSON.stringify({ type: 'session-created', session: fullWorktreeSession }));
    });

    expect(onSessionCreated).toHaveBeenCalledTimes(1);
    expect(onSessionCreated).toHaveBeenCalledWith(fullWorktreeSession);
  });

  it('session-updated: a session carrying a file-viewer worker beside a git-diff worker reaches onSessionUpdated unchanged', () => {
    // A file-viewer worker has no type-specific field: the frame must still
    // survive the strict parse (a union without the variant would drop the
    // whole frame, and the viewer tab would never appear).
    const sessionWithViewer = {
      ...quickSession,
      workers: [
        { id: 'worker-d', name: 'Diff', createdAt: '2024-01-01', type: 'git-diff', baseCommit: 'abc123' },
        { id: 'worker-v', name: 'File Viewer', createdAt: '2024-01-01', type: 'file-viewer' },
      ],
    };
    const onSessionUpdated = mock(() => {});
    renderHook(() => useAppWsEvent({ onSessionUpdated }));
    const ws = MockWebSocket.getLastInstance();

    act(() => {
      ws?.simulateOpen();
      ws?.simulateMessage(JSON.stringify({ type: 'session-updated', session: sessionWithViewer }));
    });

    expect(onSessionUpdated).toHaveBeenCalledTimes(1);
    expect(onSessionUpdated).toHaveBeenCalledWith(sessionWithViewer);
  });

  it('repository-created: a fully populated repository reaches onRepositoryCreated unchanged', () => {
    const onRepositoryCreated = mock(() => {});
    const fullRepository = {
      ...repository,
      remoteUrl: 'git@example.com:o/r.git',
      setupCommand: null,
      cleanupCommand: 'make clean',
      pauseCommand: 'docker compose stop',
      resumeCommand: null,
      envVars: 'A=1',
      description: null,
      defaultAgentId: 'agent-1',
      orchestratorSessionIds: ['session-1'],
      issueTriggerLabels: 'bug',
      sharedAccountUsername: null,
      clonedSourceRepoPath: '/repos/repo',
    };
    renderHook(() => useAppWsEvent({ onRepositoryCreated }));
    const ws = MockWebSocket.getLastInstance();

    act(() => {
      ws?.simulateOpen();
      ws?.simulateMessage(JSON.stringify({ type: 'repository-created', repository: fullRepository }));
    });

    expect(onRepositoryCreated).toHaveBeenCalledTimes(1);
    expect(onRepositoryCreated).toHaveBeenCalledWith(fullRepository);
  });

  it('worker-message: all eight fields of the one WorkerMessage the frame carries reach onWorkerMessage', () => {
    const onWorkerMessage = mock(() => {});
    renderHook(() => useAppWsEvent({ onWorkerMessage }));
    const ws = MockWebSocket.getLastInstance();

    act(() => {
      ws?.simulateOpen();
      ws?.simulateMessage(JSON.stringify({ type: 'worker-message', message: workerMessage }));
    });

    expect(onWorkerMessage).toHaveBeenCalledTimes(1);
    const received = (onWorkerMessage.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(Object.keys(received).sort()).toEqual(
      ['content', 'fromWorkerId', 'fromWorkerName', 'id', 'sessionId', 'timestamp', 'toWorkerId', 'toWorkerName'],
    );
    for (const [key, value] of Object.entries(workerMessage)) {
      expect(received[key]).toBe(value);
    }
  });
});
