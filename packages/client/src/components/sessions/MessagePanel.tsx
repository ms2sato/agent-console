import { useState, useEffect, useRef, useCallback } from 'react';
import type { WorkerMessage, Worker } from '@agent-console/shared';
import { getWorkerMessages, sendWorkerMessage } from '../../lib/api';

interface MessagePanelProps {
  sessionId: string;
  workers: Worker[];
  /** New message received via WebSocket */
  newMessage: WorkerMessage | null;
}

export function MessagePanel({ sessionId, workers, newMessage }: MessagePanelProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<WorkerMessage[]>([]);
  const [targetWorkerId, setTargetWorkerId] = useState('');
  const [content, setContent] = useState('');
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const unreadCount = useRef(0);
  const [badge, setBadge] = useState(0);

  // Fetch initial messages when panel opens
  useEffect(() => {
    if (isOpen) {
      getWorkerMessages(sessionId).then(res => {
        setMessages(res.messages);
        unreadCount.current = 0;
        setBadge(0);
      }).catch(console.error);
    }
  }, [isOpen, sessionId]);

  // Handle new messages from WebSocket
  useEffect(() => {
    if (newMessage && newMessage.sessionId === sessionId) {
      setMessages(prev => [...prev, newMessage]);
      if (!isOpen) {
        unreadCount.current++;
        setBadge(unreadCount.current);
      }
    }
  }, [newMessage, sessionId, isOpen]);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = useCallback(async () => {
    if (!targetWorkerId || !content.trim()) return;
    setSending(true);
    try {
      await sendWorkerMessage(sessionId, targetWorkerId, content.trim());
      setContent('');
    } catch (err) {
      console.error('Failed to send message:', err);
    } finally {
      setSending(false);
    }
  }, [sessionId, targetWorkerId, content]);

  // Filter to PTY workers only (agent + terminal, not git-diff)
  const ptyWorkers = workers.filter(w => w.type === 'agent' || w.type === 'terminal');

  // Set default target when workers change
  useEffect(() => {
    if (!targetWorkerId && ptyWorkers.length > 0) {
      setTargetWorkerId(ptyWorkers[0].id);
    }
  }, [targetWorkerId, ptyWorkers]);

  const handleOpen = () => {
    setIsOpen(true);
    unreadCount.current = 0;
    setBadge(0);
  };

  if (!isOpen) {
    return (
      <button
        onClick={handleOpen}
        className="fixed bottom-4 right-4 bg-slate-700 hover:bg-slate-600 text-white px-3 py-2 rounded-lg shadow-lg flex items-center gap-2 text-sm z-50"
      >
        Messages
        {badge > 0 && (
          <span className="bg-blue-500 text-white text-xs rounded-full px-1.5 py-0.5 min-w-[20px] text-center">
            {badge}
          </span>
        )}
      </button>
    );
  }

  return (
    <div className="fixed bottom-0 right-4 w-96 max-h-[60vh] bg-slate-800 border border-slate-600 rounded-t-lg shadow-2xl flex flex-col z-50">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-600 shrink-0">
        <span className="text-sm font-medium text-white">Worker Messages</span>
        <button
          onClick={() => setIsOpen(false)}
          className="text-gray-400 hover:text-white text-sm"
        >
          Close
        </button>
      </div>

      {/* Messages list */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2 min-h-[120px] max-h-[40vh]">
        {messages.length === 0 ? (
          <div className="text-gray-500 text-sm text-center py-4">
            No messages yet
          </div>
        ) : (
          messages.map(msg => (
            <div key={msg.id} className="text-sm">
              <div className="flex items-center gap-1 text-xs text-gray-400">
                <span className="font-medium text-blue-400">{msg.fromWorkerName}</span>
                <span>&rarr;</span>
                <span className="font-medium text-green-400">{msg.toWorkerName}</span>
                <span className="ml-auto">
                  {new Date(msg.timestamp).toLocaleTimeString()}
                </span>
              </div>
              <div className="text-gray-200 mt-0.5 whitespace-pre-wrap break-words bg-slate-700/50 rounded px-2 py-1">
                {msg.content}
              </div>
            </div>
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Send form */}
      <div className="border-t border-slate-600 p-2 shrink-0">
        <div className="flex gap-2 mb-2">
          <select
            value={targetWorkerId}
            onChange={e => setTargetWorkerId(e.target.value)}
            className="flex-1 bg-slate-700 text-white text-sm rounded px-2 py-1 border border-slate-600"
          >
            {ptyWorkers.map(w => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
          </select>
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            value={content}
            onChange={e => setContent(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
            placeholder="Send message to worker..."
            className="flex-1 bg-slate-700 text-white text-sm rounded px-2 py-1 border border-slate-600 placeholder-gray-500"
          />
          <button
            onClick={handleSend}
            disabled={sending || !content.trim() || !targetWorkerId}
            className="bg-blue-600 hover:bg-blue-500 disabled:bg-slate-600 disabled:text-gray-500 text-white text-sm px-3 py-1 rounded"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
