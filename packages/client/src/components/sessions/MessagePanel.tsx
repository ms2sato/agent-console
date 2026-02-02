import { useState, useEffect, useCallback, useRef } from 'react';
import type { WorkerMessage } from '@agent-console/shared';
import { MAX_MESSAGE_FILES, MAX_TOTAL_FILE_SIZE } from '@agent-console/shared';
import { sendWorkerMessage } from '../../lib/api';

interface MessagePanelProps {
  sessionId: string;
  targetWorkerId: string;
  newMessage: WorkerMessage | null;
  onError?: (title: string, message: string) => void;
}

/** Determine if the send action should be enabled. */
export function canSend(targetWorkerId: string, content: string, sending: boolean, fileCount: number): boolean {
  return !sending && (content.trim().length > 0 || fileCount > 0) && targetWorkerId.length > 0;
}

/** Validate file constraints before sending. Returns error [title, message] or null if valid. */
export function validateFiles(files: { length: number; totalSize: number }): [string, string] | null {
  if (files.length > MAX_MESSAGE_FILES) {
    return ['Too Many Files', `Maximum ${MAX_MESSAGE_FILES} files allowed`];
  }
  if (files.totalSize > MAX_TOTAL_FILE_SIZE) {
    return ['File Size Limit', `Total file size must be under ${Math.round(MAX_TOTAL_FILE_SIZE / 1024 / 1024)}MB`];
  }
  return null;
}

export function MessagePanel({ sessionId, targetWorkerId, newMessage, onError }: MessagePanelProps) {
  const [content, setContent] = useState('');
  const [sending, setSending] = useState(false);
  const [hasUnread, setHasUnread] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Clear state when target worker changes
  useEffect(() => {
    setContent('');
    setFiles([]);
    setHasUnread(false);
  }, [targetWorkerId]);

  // Show unread indicator when new message arrives for this target worker
  useEffect(() => {
    if (newMessage && newMessage.sessionId === sessionId && newMessage.toWorkerId === targetWorkerId) {
      setHasUnread(true);
    }
  }, [newMessage, sessionId, targetWorkerId]);

  const handleResize = useCallback((textarea: HTMLTextAreaElement) => {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
  }, []);

  const addFiles = useCallback((newFiles: FileList | File[]) => {
    const incoming = Array.from(newFiles);
    setFiles(prev => {
      const combined = [...prev, ...incoming];
      return combined.slice(0, MAX_MESSAGE_FILES);
    });
  }, []);

  const removeFile = useCallback((index: number) => {
    setFiles(prev => prev.filter((_, i) => i !== index));
  }, []);

  const handleSend = useCallback(async () => {
    if (!targetWorkerId || (!content.trim() && files.length === 0)) return;

    // Client-side file validation
    const totalSize = files.reduce((sum, f) => sum + f.size, 0);
    const fileError = validateFiles({ length: files.length, totalSize });
    if (fileError) {
      onError?.(fileError[0], fileError[1]);
      return;
    }

    setSending(true);
    try {
      await sendWorkerMessage(sessionId, targetWorkerId, content.trim(), files.length > 0 ? files : undefined);
      setContent('');
      setFiles([]);
      setHasUnread(false);
    } catch (err) {
      console.error('Failed to send message:', err);
      onError?.('Failed to Send Message', err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setSending(false);
    }
  }, [sessionId, targetWorkerId, content, files, onError]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files.length > 0) {
      addFiles(e.dataTransfer.files);
    }
  }, [addFiles]);

  return (
    <div
      className="bg-slate-800 border-t border-slate-700 px-3 py-2"
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <div className="flex items-end gap-2">
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

        {/* Attach button */}
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="text-gray-400 hover:text-white text-sm px-1 py-1 shrink-0"
          aria-label="Attach files"
          title="Attach files"
        >
          📎
        </button>

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = '';
          }}
        />

        {/* Send button */}
        <button
          onClick={handleSend}
          disabled={!canSend(targetWorkerId, content, sending, files.length)}
          className="bg-blue-600 hover:bg-blue-500 disabled:bg-slate-600 disabled:text-gray-500 text-white text-sm px-3 py-1 rounded shrink-0"
        >
          Send
        </button>
      </div>

      {/* File chips */}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1">
          {files.map((file, index) => (
            <span
              key={`${file.name}-${index}`}
              className="inline-flex items-center gap-1 bg-slate-700 text-gray-300 text-xs rounded px-2 py-0.5"
            >
              {file.name}
              <button
                type="button"
                onClick={() => removeFile(index)}
                className="text-gray-500 hover:text-white"
                aria-label={`Remove ${file.name}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
