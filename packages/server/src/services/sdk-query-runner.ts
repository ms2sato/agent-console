/// <reference types="../types/claude-agent-sdk" />
import type { AgentActivityState, SDKMessage } from '@agent-console/shared';
import type { InternalSdkWorker, SdkWorkerCallbacks } from './worker-types.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('sdk-query-runner');

/**
 * Derive activity state from SDK message type.
 */
function deriveActivityState(message: SDKMessage): AgentActivityState | null {
  switch (message.type) {
    case 'system':
      return 'active';
    case 'assistant': {
      // Check if assistant message contains tool_use blocks with AskUserQuestion
      const msg = message.message as { content?: Array<{ type: string; name?: string }> } | undefined;
      if (msg?.content?.some(block => block.type === 'tool_use' && block.name === 'AskUserQuestion')) {
        return 'asking';
      }
      return 'active';
    }
    case 'stream_event':
      return 'active';
    case 'result':
      return 'idle';
    default:
      return null;
  }
}

/**
 * Runtime type guard for SDKMessage validation.
 */
function isSdkMessage(value: unknown): value is SDKMessage {
  return typeof value === 'object'
    && value !== null
    && 'type' in value
    && typeof (value as { type?: unknown }).type === 'string';
}

/**
 * Broadcast a message to all connected clients of an SDK worker.
 */
function broadcastToCallbacks(worker: InternalSdkWorker, fn: (callbacks: SdkWorkerCallbacks) => void): void {
  const snapshot = Array.from(worker.connectionCallbacks.values());
  for (const callbacks of snapshot) {
    fn(callbacks);
  }
}

/**
 * Set activity state on worker and notify all callbacks.
 */
function setActivityState(
  worker: InternalSdkWorker,
  state: AgentActivityState,
  globalActivityCallback?: (workerId: string, state: AgentActivityState) => void
): void {
  if (worker.activityState === state) return;
  worker.activityState = state;
  broadcastToCallbacks(worker, (cb) => cb.onActivityChange(state));
  globalActivityCallback?.(worker.id, state);
}

/**
 * Callback type for persisting SDK messages to storage.
 * Receives the message after it's been validated and added to worker memory.
 */
export type PersistMessageCallback = (message: SDKMessage) => Promise<void>;

/**
 * Run a Claude Code SDK query for the given worker.
 * Iterates the async generator and forwards messages to connected clients.
 *
 * Note: The actual SDK import is deferred to allow the module to be loaded
 * even when the SDK is not installed (for testing).
 */
export async function runSdkQuery(
  worker: InternalSdkWorker,
  prompt: string,
  cwd: string,
  options?: {
    globalActivityCallback?: (workerId: string, state: AgentActivityState) => void;
    permissionMode?: string;
    /** Callback to persist each message to file storage. Errors are logged but don't interrupt the query. */
    onPersistMessage?: PersistMessageCallback;
  }
): Promise<void> {
  if (worker.isRunning) {
    logger.warn({ workerId: worker.id }, 'SDK query already running');
    return;
  }

  worker.isRunning = true;
  const abortController = new AbortController();
  worker.abortController = abortController;

  setActivityState(worker, 'active', options?.globalActivityCallback);

  try {
    // Dynamic import to allow graceful handling when SDK is not installed
    const { query } = await import('@anthropic-ai/claude-agent-sdk');

    const queryOptions: import('@anthropic-ai/claude-agent-sdk').QueryOptions = {
      cwd,
      includePartialMessages: true,
      abortController,
      // bypassPermissions is the appropriate default for agent-console:
      // users launch agents intentionally and expect autonomous operation.
      // Individual agent definitions can override this via configuration.
      permissionMode: options?.permissionMode ?? 'bypassPermissions',
    };

    if (worker.sdkSessionId) {
      queryOptions.resume = worker.sdkSessionId;
    }

    const stream = query({
      prompt,
      options: queryOptions,
    });

    for await (const sdkMessage of stream) {
      if (abortController.signal.aborted) break;

      if (!isSdkMessage(sdkMessage)) {
        logger.warn({ workerId: worker.id, message: sdkMessage }, 'Skipping invalid SDK message');
        continue;
      }

      // Capture session ID from system init message
      if (sdkMessage.type === 'system' && typeof sdkMessage.session_id === 'string') {
        worker.sdkSessionId = sdkMessage.session_id;
      }

      // Store message in history
      worker.messages.push(sdkMessage);

      // Persist message to file storage.
      // Intentionally fire-and-forget: we don't await here to avoid blocking
      // the streaming response. File I/O latency should not delay message delivery
      // to connected clients. Errors are logged but don't interrupt the query flow.
      // See: docs/design/claude-code-sdk-integration.md "Fire-and-forget file writes"
      if (options?.onPersistMessage) {
        options.onPersistMessage(sdkMessage).catch((err) => {
          logger.error({ workerId: worker.id, err }, 'Failed to persist SDK message');
        });
      }

      // Broadcast to connected clients
      broadcastToCallbacks(worker, (cb) => cb.onMessage(sdkMessage));

      // Derive and set activity state
      const newState = deriveActivityState(sdkMessage);
      if (newState) {
        setActivityState(worker, newState, options?.globalActivityCallback);
      }
    }
  } catch (err) {
    const isAbort = err instanceof Error && err.message.includes('aborted');
    if (!isAbort) {
      logger.error({ workerId: worker.id, err }, 'SDK query error');
    }
    // Notify clients of exit
    broadcastToCallbacks(worker, (cb) => cb.onExit(isAbort ? 0 : 1, isAbort ? 'SIGTERM' : null));
  } finally {
    worker.isRunning = false;
    worker.abortController = null;
    setActivityState(worker, 'idle', options?.globalActivityCallback);
  }
}

/**
 * Cancel a running SDK query.
 */
export function cancelSdkQuery(worker: InternalSdkWorker): void {
  if (worker.abortController) {
    worker.abortController.abort();
    logger.info({ workerId: worker.id }, 'SDK query cancelled');
  }
}
