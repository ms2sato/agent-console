import { useState, useEffect, useCallback } from 'react';
import type { WorkerMessage } from '@agent-console/shared';
import { sendWorkerMessage } from '../../lib/api';

interface MessagePanelProps {
  sessionId: string;
  targetWorkerId: string;
  newMessage: WorkerMessage | null;
  onError?: (title: string, message: string) => void;
}

/** Determine if the send action should be enabled. */
export function canSend(targetWorkerId: string, content: string, sending: boolean): boolean {
  return !sending && content.trim().length > 0 && targetWorkerId.length > 0;
}

export function MessagePanel({ sessionId, targetWorkerId, newMessage, onError }: MessagePanelProps) {
  const [content, setContent] = useState('');
  const [sending, setSending] = useState(false);
  const [hasUnread, setHasUnread] = useState(false);

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
      onError?.('Failed to Send Message', err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setSending(false);
    }
  }, [sessionId, targetWorkerId, content, onError]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  return (
    <div className="bg-slate-800 border-t border-slate-700 px-3 py-2 flex items-end gap-2">
      {/* Unread indicator */}
      {hasUnread && (
        <span className="w-2 h-2 bg-blue-500 rounded-full shrink-0" />
      )}

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
        disabled={!canSend(targetWorkerId, content, sending)}
        className="bg-blue-600 hover:bg-blue-500 disabled:bg-slate-600 disabled:text-gray-500 text-white text-sm px-3 py-1 rounded shrink-0"
      >
        Send
      </button>
    </div>
  );
}
