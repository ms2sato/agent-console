import { useState, useEffect, useCallback, useRef, forwardRef, useImperativeHandle } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { WorkerMessage, SkillDefinition } from '@agent-console/shared';
import { MAX_MESSAGE_FILES, MAX_TOTAL_FILE_SIZE } from '@agent-console/shared';
import { sendWorkerMessage, fetchSkills } from '../../lib/api';
import { sendInput as sendPtyInput } from '../../lib/worker-websocket';
import { useDraftMessage } from '../../hooks/useDraftMessage';
import { useMessageTemplates } from '../../hooks/useMessageTemplates';
import { skillKeys } from '../../lib/query-keys';
import { TemplateSelector } from './TemplateSelector';
import { TemplateManager } from './TemplateManager';

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

export interface MessagePanelHandle {
  addFiles: (files: File[] | FileList) => void;
}

export const MessagePanel = forwardRef<MessagePanelHandle, MessagePanelProps>(
  function MessagePanel({ sessionId, targetWorkerId, newMessage, onError }, ref) {
  const { content, setContent, clearDraft } = useDraftMessage(sessionId, targetWorkerId);
  const [sending, setSending] = useState(false);
  const [hasUnread, setHasUnread] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [completionDismissed, setCompletionDismissed] = useState(false);
  const [templateSelectorOpen, setTemplateSelectorOpen] = useState(false);
  const [templateManagerOpen, setTemplateManagerOpen] = useState(false);
  const [templateManagerInitialContent, setTemplateManagerInitialContent] = useState<string | undefined>(undefined);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { templates, addTemplate, updateTemplate, deleteTemplate, reorderTemplates } = useMessageTemplates();

  // Fetch slash commands from server
  const { data: skillsData } = useQuery({
    queryKey: skillKeys.all(),
    queryFn: fetchSkills,
    staleTime: 5 * 60 * 1000, // Skills rarely change
  });
  const slashCommands = skillsData?.skills ?? [];

  // Slash command completion - derived state
  const isSlashPrefix = content.startsWith('/') && !content.includes(' ');
  const filteredCommands = isSlashPrefix
    ? slashCommands.filter(cmd => cmd.name.toLowerCase().startsWith(content.toLowerCase()))
    : [];
  const showCompletion = isSlashPrefix && filteredCommands.length > 0 && !completionDismissed;
  // Clamp selectedIndex to valid range
  const clampedIndex = filteredCommands.length > 0
    ? Math.min(selectedIndex, filteredCommands.length - 1)
    : 0;

  // Clear non-draft state when target worker changes
  useEffect(() => {
    setFiles([]);
    setHasUnread(false);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
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

  useImperativeHandle(ref, () => ({
    addFiles,
  }), [addFiles]);

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
      await sendWorkerMessage(sessionId, targetWorkerId, content, files.length > 0 ? files : undefined);
      clearDraft();
      setFiles([]);
      setHasUnread(false);
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
    } catch (err) {
      console.error('Failed to send message:', err);
      onError?.('Failed to Send Message', err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setSending(false);
    }
  }, [sessionId, targetWorkerId, content, files, onError, clearDraft]);

  const selectCommand = useCallback((command: SkillDefinition) => {
    setContent(command.name + ' ');
    setCompletionDismissed(false);
    textareaRef.current?.focus();
  }, [setContent]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Ctrl/Cmd+Enter always sends, even with dropdown visible
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      handleSend();
      return;
    }

    // Template selector toggle with Ctrl+/
    if (e.ctrlKey && e.key === '/' && !showCompletion) {
      e.preventDefault();
      setTemplateSelectorOpen(prev => !prev);
      return;
    }

    // Template selector key handling
    if (templateSelectorOpen) {
      // Let TemplateSelector handle its own keyboard events
      return;
    }

    // Dropdown-specific key handling
    if (showCompletion) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex(prev => Math.min(prev + 1, filteredCommands.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex(prev => Math.max(prev - 1, 0));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        selectCommand(filteredCommands[clampedIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setCompletionDismissed(true);
        return;
      }
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      sendPtyInput(sessionId, targetWorkerId, '\x1b');
    }
  }, [handleSend, sessionId, targetWorkerId, showCompletion, templateSelectorOpen, filteredCommands, clampedIndex, selectCommand]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files.length > 0) {
      addFiles(e.dataTransfer.files);
    }
  }, [addFiles]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const imageFiles: File[] = [];
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const blob = item.getAsFile();
        if (blob) imageFiles.push(blob);
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault();
      addFiles(imageFiles);
    }
    // If no images, let textarea handle normal text paste
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

        {/* Message textarea with completion dropdown and template selector */}
        <div className="flex-1 relative">
          {templateSelectorOpen && (
            <TemplateSelector
              templates={templates}
              onSelect={templateContent => {
                setContent(templateContent);
                setTemplateSelectorOpen(false);
                textareaRef.current?.focus();
              }}
              onClose={() => {
                setTemplateSelectorOpen(false);
                textareaRef.current?.focus();
              }}
              onManage={() => {
                setTemplateSelectorOpen(false);
                setTemplateManagerInitialContent(undefined);
                setTemplateManagerOpen(true);
              }}
            />
          )}
          {showCompletion && (
            <ul
              role="listbox"
              className="absolute bottom-full left-0 mb-1 w-full bg-slate-800 border border-slate-600 rounded shadow-lg max-h-60 overflow-y-auto z-10"
            >
              {filteredCommands.map((cmd, index) => (
                <li
                  key={cmd.name}
                  role="option"
                  aria-selected={index === clampedIndex}
                  className={`px-3 py-1.5 cursor-pointer text-sm ${
                    index === clampedIndex ? 'bg-slate-700 text-white' : 'text-gray-300 hover:bg-slate-700'
                  }`}
                  onMouseDown={e => {
                    e.preventDefault(); // prevent textarea blur
                    selectCommand(cmd);
                  }}
                >
                  <span className="font-medium text-blue-400">{cmd.name}</span>
                  <span className="ml-2 text-gray-400">{cmd.description}</span>
                </li>
              ))}
            </ul>
          )}
          <textarea
            ref={textareaRef}
            value={content}
            onChange={e => {
              setContent(e.target.value);
              setSelectedIndex(0);
              setCompletionDismissed(false);
              handleResize(e.target);
            }}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder="Send message to worker... (Ctrl+Enter to send)"
            rows={1}
            className="w-full bg-slate-700 text-white text-sm rounded px-2 py-1 border border-slate-600 placeholder-gray-500 resize-none overflow-y-auto"
            style={{ maxHeight: '120px' }}
          />
        </div>

        {/* Template button */}
        <button
          type="button"
          onClick={() => setTemplateSelectorOpen(prev => !prev)}
          className="text-gray-400 hover:text-white text-sm px-1 py-1 shrink-0"
          aria-label="Message templates"
          title="Message templates (Ctrl+/)"
        >
          📋
        </button>

        {/* Save as template button - only visible when there's content */}
        {content.trim() && (
          <button
            type="button"
            onClick={() => {
              setTemplateManagerInitialContent(content.trim());
              setTemplateManagerOpen(true);
            }}
            className="text-gray-400 hover:text-white text-sm px-1 py-1 shrink-0"
            aria-label="Save as template"
            title="Save current message as template"
          >
            💾
          </button>
        )}

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

      {/* Template manager dialog */}
      <TemplateManager
        open={templateManagerOpen}
        onOpenChange={setTemplateManagerOpen}
        templates={templates}
        onAdd={addTemplate}
        onUpdate={updateTemplate}
        onDelete={deleteTemplate}
        onReorder={reorderTemplates}
        initialContent={templateManagerInitialContent}
      />
    </div>
  );
  }
);
