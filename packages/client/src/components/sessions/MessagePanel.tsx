import { useState, useEffect, useCallback } from 'react';
import type { WorkerMessage, Worker } from '@agent-console/shared';
import { sendWorkerMessage } from '../../lib/api';

interface MessagePanelProps {
  sessionId: string;
  workers: Worker[];
  activeWorkerId: string | null;
  newMessage: WorkerMessage | null;
}

/** Filter workers to only include agent workers (valid message targets). */
export function getAgentWorkers(workers: Worker[]): Worker[] {
  return workers.filter(w => w.type === 'agent');
}

/** Determine the initial target worker for message sending. */
export function getInitialTargetWorkerId(
  activeWorkerId: string | null,
  agentWorkers: Worker[]
): string {
  if (activeWorkerId && agentWorkers.some(w => w.id === activeWorkerId)) {
    return activeWorkerId;
  }
  return agentWorkers[0]?.id ?? '';
}

/** Determine if the send action should be enabled. */
export function canSend(targetWorkerId: string, content: string, sending: boolean): boolean {
  return !sending && content.trim().length > 0 && targetWorkerId.length > 0;
}

export function MessagePanel({ sessionId, workers, activeWorkerId, newMessage }: MessagePanelProps) {
  const agentWorkers = getAgentWorkers(workers);

  const [targetWorkerId, setTargetWorkerId] = useState(() =>
    getInitialTargetWorkerId(activeWorkerId, agentWorkers)
  );
  const [content, setContent] = useState('');
  const [sending, setSending] = useState(false);
  const [hasUnread, setHasUnread] = useState(false);

  // Update target when activeWorkerId changes to an agent worker
  useEffect(() => {
    if (activeWorkerId && agentWorkers.some(w => w.id === activeWorkerId)) {
      if (targetWorkerId !== activeWorkerId) {
        setTargetWorkerId(activeWorkerId);
      }
    }
  }, [activeWorkerId, agentWorkers, targetWorkerId]);

  // Reset target if it's no longer valid
  useEffect(() => {
    if (targetWorkerId && !agentWorkers.some(w => w.id === targetWorkerId)) {
      const newTarget = agentWorkers[0]?.id ?? '';
      setTargetWorkerId(newTarget);
    }
  }, [targetWorkerId, agentWorkers]);

  // Show unread indicator when new message arrives
  useEffect(() => {
    if (newMessage && newMessage.sessionId === sessionId) {
      setHasUnread(true);
    }
  }, [newMessage, sessionId]);

  // Reset unread indicator on session change
  useEffect(() => {
    setHasUnread(false);
  }, [sessionId]);

  const handleResize = useCallback((textarea: HTMLTextAreaElement) => {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
  }, []);

  const handleSend = useCallback(async () => {
    if (!targetWorkerId || !content.trim()) return;
    setSending(true);
    try {
      await sendWorkerMessage(sessionId, targetWorkerId, content.trim());
      setContent('');
      setHasUnread(false);
    } catch (err) {
      console.error('Failed to send message:', err);
    } finally {
      setSending(false);
    }
  }, [sessionId, targetWorkerId, content]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  // No agent workers - show disabled state
  if (agentWorkers.length === 0) {
    return (
      <div className="bg-slate-800 border-t border-slate-700 px-3 py-2 flex items-center gap-2">
        <input
          type="text"
          disabled
          placeholder="No agent workers available"
          className="flex-1 bg-slate-700 text-gray-500 text-sm rounded px-2 py-1 border border-slate-600"
        />
      </div>
    );
  }

  return (
    <div className="bg-slate-800 border-t border-slate-700 px-3 py-2 flex items-center gap-2">
      {/* Target worker select */}
      <div className="relative">
        <select
          value={targetWorkerId}
          onChange={e => setTargetWorkerId(e.target.value)}
          className="bg-slate-700 text-white text-sm rounded px-2 py-1 border border-slate-600"
        >
          {agentWorkers.map(w => (
            <option key={w.id} value={w.id}>{w.name}</option>
          ))}
        </select>
        {/* Unread indicator */}
        {hasUnread && (
          <span className="absolute -top-1 -right-1 w-2 h-2 bg-blue-500 rounded-full" />
        )}
      </div>

      {/* Message textarea */}
      <textarea
        value={content}
        onChange={e => {
          setContent(e.target.value);
          handleResize(e.target);
        }}
        onKeyDown={handleKeyDown}
        placeholder="Send message to worker... (Ctrl+Enter to send)"
        rows={1}
        className="flex-1 bg-slate-700 text-white text-sm rounded px-2 py-1 border border-slate-600 placeholder-gray-500 resize-none overflow-y-auto"
        style={{ maxHeight: '120px' }}
      />

      {/* Send button */}
      <button
        onClick={handleSend}
        disabled={sending || !content.trim() || !targetWorkerId}
        className="bg-blue-600 hover:bg-blue-500 disabled:bg-slate-600 disabled:text-gray-500 text-white text-sm px-3 py-1 rounded shrink-0"
      >
        Send
      </button>
    </div>
  );
}
