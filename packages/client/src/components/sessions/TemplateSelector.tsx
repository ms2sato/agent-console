import { useState, useRef, useEffect, useCallback } from 'react';
import type { MessageTemplate } from '../../hooks/useMessageTemplates';
import { cn } from '../../lib/utils';

interface TemplateSelectorProps {
  templates: MessageTemplate[];
  onSelect: (content: string) => void;
  onClose: () => void;
  onManage: () => void;
}

export function TemplateSelector({ templates, onSelect, onClose, onManage }: TemplateSelectorProps) {
  const [filter, setFilter] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const filtered = filter
    ? templates.filter(
        t =>
          t.title.toLowerCase().includes(filter.toLowerCase()) ||
          t.content.toLowerCase().includes(filter.toLowerCase()),
      )
    : templates;

  const clampedIndex = filtered.length > 0 ? Math.min(selectedIndex, filtered.length - 1) : -1;

  useEffect(() => {
    searchInputRef.current?.focus();
  }, []);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex(prev => Math.min(prev + 1, filtered.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex(prev => Math.max(prev - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (clampedIndex >= 0 && filtered[clampedIndex]) {
          onSelect(filtered[clampedIndex].content);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    },
    [filtered, clampedIndex, onSelect, onClose],
  );

  function truncate(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen) + '...';
  }

  return (
    <div
      ref={containerRef}
      className="absolute bottom-full left-0 mb-1 w-full bg-slate-800 border border-slate-600 rounded shadow-lg z-10"
      onKeyDown={handleKeyDown}
    >
      <div className="p-2 border-b border-slate-700">
        <input
          ref={searchInputRef}
          type="text"
          value={filter}
          onChange={e => {
            setFilter(e.target.value);
            setSelectedIndex(0);
          }}
          placeholder="Search templates..."
          className="w-full bg-slate-700 text-white text-sm rounded px-2 py-1 border border-slate-600 placeholder-gray-500"
        />
      </div>

      {filtered.length === 0 ? (
        <div className="px-3 py-3 text-sm text-gray-400">
          {templates.length === 0
            ? 'No templates saved. Use "Manage Templates" to create one.'
            : 'No templates match your search.'}
        </div>
      ) : (
        <ul role="listbox" className="max-h-48 overflow-y-auto">
          {filtered.map((template, index) => (
            <li
              key={template.id}
              role="option"
              aria-selected={index === clampedIndex}
              className={cn(
                'px-3 py-1.5 cursor-pointer text-sm',
                index === clampedIndex ? 'bg-slate-700 text-white' : 'text-gray-300 hover:bg-slate-700',
              )}
              onMouseDown={e => {
                e.preventDefault();
                onSelect(template.content);
              }}
              onMouseEnter={() => setSelectedIndex(index)}
            >
              <span className="font-medium text-blue-400">{template.title}</span>
              <span className="ml-2 text-gray-400">{truncate(template.content.replace(/\n/g, ' '), 60)}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="border-t border-slate-700 px-3 py-2">
        <button
          type="button"
          className="text-sm text-blue-400 hover:text-blue-300"
          onMouseDown={e => {
            e.preventDefault();
            onManage();
          }}
        >
          Manage Templates...
        </button>
      </div>
    </div>
  );
}
