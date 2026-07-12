import { useRef, useEffect } from 'react';
import { useEmbeddedAgentWorker } from './hooks/useEmbeddedAgentWorker';
import type { EmbeddedAgentChatEntry } from './embedded-agent-store';
import { RefreshIcon, StopIcon, AlertCircleIcon } from '../Icons';
import { MessagePanel } from '../sessions/MessagePanel';

interface EmbeddedAgentWorkerViewProps {
  sessionId: string;
  workerId: string;
}

export function EmbeddedAgentWorkerView({ sessionId, workerId }: EmbeddedAgentWorkerViewProps) {
  const {
    status,
    entries,
    activityState,
    workerError,
    sendUserMessage,
    cancel,
    restart,
    retry,
    dismissError,
  } = useEmbeddedAgentWorker({ sessionId, workerId });

  const listRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to the newest entry. Component-scoped DOM interaction is an
  // accepted useEffect use per frontend.md ("Avoid useEffect" table).
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [entries.length]);

  const isTurnActive = activityState === 'active';

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-slate-900">
      {/* Persistent, non-dismissable reset-on-restart notice. This is a
          permanent fixture of the view (v1 worker-type inconsistency called
          out in docs/design/embedded-agent-worker.md "Design Decisions"),
          not a toast -- it has no close button. */}
      <div className="px-4 py-2 bg-amber-900/20 border-b border-amber-700/40 text-amber-200 text-xs shrink-0">
        Conversation resets when this worker or the server restarts (no transcript persistence in v1).
      </div>

      {workerError && (
        <div
          role="alert"
          className="px-4 py-2 bg-red-900/30 border-b border-red-700/50 text-red-200 text-sm shrink-0 flex items-center justify-between gap-3"
        >
          <span className="flex items-center gap-2">
            <AlertCircleIcon className="w-4 h-4 shrink-0" />
            {workerError.message}
          </span>
          {workerError.code === 'ACTIVATION_FAILED' ? (
            <button onClick={retry} className="btn btn-primary text-xs shrink-0">
              Retry
            </button>
          ) : (
            <button onClick={dismissError} className="text-red-300 hover:text-white text-xs shrink-0">
              Dismiss
            </button>
          )}
        </div>
      )}

      <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3">
        {entries.length === 0 && (
          <div className="text-gray-500 text-sm">No messages yet. Say hello to get started.</div>
        )}
        {entries.map((entry) => (
          <ChatEntryRow key={entry.key} entry={entry} onRestart={restart} />
        ))}
      </div>

      <div className="border-t border-slate-700 px-4 py-3 shrink-0 flex flex-col gap-2">
        <div className="flex items-center gap-2 text-xs text-gray-400">
          <span className={`inline-block w-2 h-2 rounded-full ${activityStateColor(activityState)}`} aria-hidden="true" />
          {activityStateLabel(status, activityState)}
          {isTurnActive && (
            <button
              onClick={cancel}
              className="ml-auto flex items-center gap-1 text-xs px-2 py-1 rounded bg-red-900/40 text-red-300 hover:bg-red-900/60"
            >
              <StopIcon className="w-3.5 h-3.5" />
              Cancel
            </button>
          )}
        </div>
        <MessagePanel
          sessionId={sessionId}
          targetWorkerId={workerId}
          newMessage={null}
          onSend={async (content) => {
            sendUserMessage(content);
          }}
          slashCompletionEnabled={false}
          attachmentsEnabled={false}
          sendDisabled={isTurnActive}
        />
      </div>
    </div>
  );
}

function activityStateColor(state: string): string {
  switch (state) {
    case 'active':
      return 'bg-blue-500';
    case 'idle':
      return 'bg-green-500';
    default:
      return 'bg-gray-500';
  }
}

function activityStateLabel(status: string, activityState: string): string {
  if (status === 'connecting') return 'Connecting...';
  if (status === 'disconnected') return 'Disconnected';
  switch (activityState) {
    case 'active':
      return 'Working...';
    case 'idle':
      return 'Idle';
    default:
      return 'Connected';
  }
}

interface ChatEntryRowProps {
  entry: EmbeddedAgentChatEntry;
  onRestart: () => void;
}

function ChatEntryRow({ entry, onRestart }: ChatEntryRowProps) {
  switch (entry.kind) {
    case 'user-message':
      return (
        <div className="flex justify-end">
          <div className="max-w-[80%] rounded-lg bg-blue-600/80 text-white px-3 py-2 text-sm whitespace-pre-wrap">
            {entry.text}
          </div>
        </div>
      );
    case 'assistant-message':
      return (
        <div className="flex justify-start">
          <div className="max-w-[80%] rounded-lg bg-slate-800 text-gray-100 px-3 py-2 text-sm whitespace-pre-wrap">
            {entry.text}
            {entry.streaming && <span className="inline-block w-1.5 h-3.5 ml-0.5 bg-gray-400 animate-pulse align-middle" aria-hidden="true" />}
          </div>
        </div>
      );
    case 'tool-call':
      return <ToolCallCard entry={entry} />;
    case 'turn-error':
      return (
        <div className="text-sm text-red-400 bg-red-950/40 border border-red-800/50 rounded px-3 py-2">
          Turn error: {entry.message}
        </div>
      );
    case 'fatal':
      return (
        <div className="text-sm text-red-300 bg-red-950/60 border border-red-700 rounded px-3 py-2 font-medium">
          Fatal: {entry.message}
        </div>
      );
    case 'exited':
      return (
        <div className="flex items-center gap-3 text-sm text-gray-400 bg-slate-800/60 rounded px-3 py-2">
          <span>Agent process exited{entry.code !== null ? ` (code: ${entry.code})` : ''}.</span>
          <button
            onClick={onRestart}
            className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-gray-200"
          >
            <RefreshIcon className="w-3.5 h-3.5" />
            Restart
          </button>
        </div>
      );
    default: {
      const _exhaustive: never = entry;
      return _exhaustive;
    }
  }
}

type ToolCallEntry = Extract<EmbeddedAgentChatEntry, { kind: 'tool-call' }>;

function ToolCallCard({ entry }: { entry: ToolCallEntry }) {
  const hasResult = entry.result !== null;
  const isError = hasResult && entry.result?.ok === false;

  return (
    <div
      className={`text-sm rounded border px-3 py-2 ${
        isError ? 'bg-red-950/30 border-red-800/50' : 'bg-slate-800 border-slate-700'
      }`}
    >
      <details>
        <summary className="cursor-pointer text-gray-300 font-mono text-xs flex items-center gap-2">
          <span className="text-purple-400">tool</span>
          {entry.name}
          {!hasResult && <span className="text-gray-500">(running...)</span>}
        </summary>
        <pre className="mt-2 text-xs text-gray-400 overflow-x-auto whitespace-pre-wrap">
          {JSON.stringify(entry.args, null, 2)}
        </pre>
      </details>
      {hasResult && (
        <div className={`mt-2 text-xs font-mono whitespace-pre-wrap ${isError ? 'text-red-300' : 'text-gray-400'}`}>
          {entry.result?.result}
        </div>
      )}
    </div>
  );
}
