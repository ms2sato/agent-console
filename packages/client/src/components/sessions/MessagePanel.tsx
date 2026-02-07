import { useState, useEffect, useCallback } from 'react';
import type { WorkerMessage } from '@agent-console/shared';
import { sendWorkerMessage } from '../../lib/api';
import { MessageInput, validateFiles } from './MessageInput';

interface MessagePanelProps {
  sessionId: string;
  targetWorkerId: string;
  newMessage: WorkerMessage | null;
  onError?: (title: string, message: string) => void;
}

// Re-export for backward compatibility with existing tests
export { canSend, validateFiles } from './MessageInput';

export function MessagePanel({ sessionId, targetWorkerId, newMessage, onError }: MessagePanelProps) {
  const [sending, setSending] = useState(false);
  const [hasUnread, setHasUnread] = useState(false);
  // Key to force MessageInput remount when target worker changes
  const [inputKey, setInputKey] = useState(0);

  // Clear state when target worker changes
  useEffect(() => {
    setHasUnread(false);
    // Increment key to remount MessageInput and reset its internal state
    setInputKey(prev => prev + 1);
  }, [targetWorkerId]);

  // Show unread indicator when new message arrives for this target worker
  useEffect(() => {
    if (newMessage && newMessage.sessionId === sessionId && newMessage.toWorkerId === targetWorkerId) {
      setHasUnread(true);
    }
  }, [newMessage, sessionId, targetWorkerId]);

  const handleSend = useCallback(
    async (content: string, files?: File[]) => {
      if (!targetWorkerId || (!content.trim() && (!files || files.length === 0))) return;

      // Client-side file validation
      if (files && files.length > 0) {
        const totalSize = files.reduce((sum, f) => sum + f.size, 0);
        const fileError = validateFiles({ length: files.length, totalSize });
        if (fileError) {
          onError?.(fileError[0], fileError[1]);
          throw new Error(fileError[1]); // Throw to prevent form reset
        }
      }

      setSending(true);
      try {
        await sendWorkerMessage(sessionId, targetWorkerId, content.trim(), files);
        setHasUnread(false);
      } catch (err) {
        console.error('Failed to send message:', err);
        onError?.('Failed to Send Message', err instanceof Error ? err.message : 'Unknown error');
        throw err; // Re-throw to prevent form reset in MessageInput
      } finally {
        setSending(false);
      }
    },
    [sessionId, targetWorkerId, onError],
  );

  return (
    <div className="relative">
      {/* Unread indicator - positioned before the input */}
      {hasUnread && (
        <div className="absolute left-1 top-1/2 -translate-y-1/2 z-10">
          <span className="w-2 h-2 bg-blue-500 rounded-full block" />
        </div>
      )}
      <MessageInput
        key={inputKey}
        onSend={handleSend}
        placeholder="Send message to worker... (Ctrl+Enter to send)"
        disabled={!targetWorkerId}
        sending={sending}
      />
    </div>
  );
}
