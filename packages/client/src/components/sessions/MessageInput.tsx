import { useState, useCallback, useRef } from 'react';
import { MAX_MESSAGE_FILES, MAX_TOTAL_FILE_SIZE } from '@agent-console/shared';

export interface MessageInputProps {
  onSend: (content: string, files?: File[]) => Promise<void>;
  placeholder?: string;
  disabled?: boolean;
  sending?: boolean;
}

/** Determine if the send action should be enabled (for external use with targetWorkerId). */
export function canSend(targetWorkerId: string, content: string, sending: boolean, fileCount: number): boolean {
  if (!targetWorkerId || sending) return false;
  return content.trim().length > 0 || fileCount > 0;
}

/** Internal check for enabling send within the component. */
function canSendInternal(content: string, sending: boolean, fileCount: number, disabled: boolean): boolean {
  if (disabled || sending) return false;
  return content.trim().length > 0 || fileCount > 0;
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

export function MessageInput({
  onSend,
  placeholder = 'Send message... (Ctrl+Enter to send)',
  disabled = false,
  sending = false,
}: MessageInputProps) {
  const [content, setContent] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const resetForm = useCallback(() => {
    setContent('');
    setFiles([]);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, []);

  const handleSend = useCallback(async () => {
    if (disabled || (!content.trim() && files.length === 0)) return;

    try {
      await onSend(content.trim(), files.length > 0 ? files : undefined);
      resetForm();
    } catch {
      // Error handling is delegated to the parent through onSend
      // Parent should handle displaying errors
    }
  }, [disabled, content, files, onSend, resetForm]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer.files.length > 0) {
        addFiles(e.dataTransfer.files);
      }
    },
    [addFiles],
  );

  return (
    <div className="bg-slate-800 border-t border-slate-700 px-3 py-2" onDragOver={handleDragOver} onDrop={handleDrop}>
      <div className="flex items-end gap-2">
        {/* Message textarea */}
        <textarea
          ref={textareaRef}
          value={content}
          onChange={e => {
            setContent(e.target.value);
            handleResize(e.target);
          }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          rows={1}
          disabled={disabled}
          className="flex-1 bg-slate-700 text-white text-sm rounded px-2 py-1 border border-slate-600 placeholder-gray-500 resize-none overflow-y-auto disabled:opacity-50"
          style={{ height: 'auto', maxHeight: '120px' }}
        />

        {/* Attach button */}
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="text-gray-400 hover:text-white text-sm px-1 py-1 shrink-0 disabled:opacity-50"
          aria-label="Attach files"
          title="Attach files"
          disabled={disabled}
        >
          {/* Paperclip emoji */}
          {'\u{1F4CE}'}
        </button>

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={e => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = '';
          }}
        />

        {/* Send button */}
        <button
          onClick={handleSend}
          disabled={!canSendInternal(content, sending, files.length, disabled)}
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
                {'\u00D7'}
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
