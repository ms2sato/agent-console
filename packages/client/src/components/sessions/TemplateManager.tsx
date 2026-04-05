import { useState, useEffect } from 'react';
import type { MessageTemplate } from '../../hooks/useMessageTemplates';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '../ui/dialog';
import { cn } from '../../lib/utils';

interface TemplateManagerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  templates: MessageTemplate[];
  onAdd: (name: string, content: string) => void;
  onUpdate: (id: string, updates: Partial<Pick<MessageTemplate, 'name' | 'content'>>) => void;
  onDelete: (id: string) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  initialContent?: string;
}

export function TemplateManager({
  open,
  onOpenChange,
  templates,
  onAdd,
  onUpdate,
  onDelete,
  onReorder,
  initialContent,
}: TemplateManagerProps) {
  const [newName, setNewName] = useState('');
  const [newContent, setNewContent] = useState(initialContent ?? '');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editContent, setEditContent] = useState('');
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  // Reset form state when dialog opens (useState only uses initial value on first render,
  // but this component stays mounted via Radix Dialog's `open` prop)
  useEffect(() => {
    if (open) {
      setNewName('');
      setNewContent(initialContent ?? '');
      setEditingId(null);
      setDeleteConfirmId(null);
    }
  }, [open, initialContent]);

  function handleAdd() {
    if (!newName.trim() || !newContent.trim()) return;
    onAdd(newName.trim(), newContent.trim());
    setNewName('');
    setNewContent('');
  }

  function startEdit(template: MessageTemplate) {
    setEditingId(template.id);
    setEditName(template.name);
    setEditContent(template.content);
  }

  function saveEdit() {
    if (!editingId || !editName.trim() || !editContent.trim()) return;
    onUpdate(editingId, { name: editName.trim(), content: editContent.trim() });
    setEditingId(null);
  }

  function cancelEdit() {
    setEditingId(null);
  }

  function handleDelete(id: string) {
    onDelete(id);
    setDeleteConfirmId(null);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Manage Templates</DialogTitle>
          <DialogDescription>Create, edit, and organize your message templates.</DialogDescription>
        </DialogHeader>

        {/* Add new template form */}
        <div className="space-y-2 mb-4">
          <h3 className="text-sm font-medium text-gray-300">
            {initialContent ? 'Save Current Message as Template' : 'Add New Template'}
          </h3>
          <input
            type="text"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            placeholder="Template name"
            className="w-full bg-slate-700 text-white text-sm rounded px-2 py-1 border border-slate-600 placeholder-gray-500"
          />
          <textarea
            value={newContent}
            onChange={e => setNewContent(e.target.value)}
            placeholder="Template content"
            rows={3}
            className="w-full bg-slate-700 text-white text-sm rounded px-2 py-1 border border-slate-600 placeholder-gray-500 resize-none"
          />
          <button
            type="button"
            onClick={handleAdd}
            disabled={!newName.trim() || !newContent.trim()}
            className="bg-blue-600 hover:bg-blue-500 disabled:bg-slate-600 disabled:text-gray-500 text-white text-sm px-3 py-1 rounded"
          >
            Add Template
          </button>
        </div>

        {/* Template list */}
        {templates.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-sm font-medium text-gray-300">Saved Templates</h3>
            <ul className="space-y-2">
              {templates.map((template, index) => (
                <li
                  key={template.id}
                  className="bg-slate-700 rounded p-3 space-y-2"
                >
                  {editingId === template.id ? (
                    <div className="space-y-2">
                      <input
                        type="text"
                        value={editName}
                        onChange={e => setEditName(e.target.value)}
                        className="w-full bg-slate-600 text-white text-sm rounded px-2 py-1 border border-slate-500"
                        aria-label="Edit template name"
                      />
                      <textarea
                        value={editContent}
                        onChange={e => setEditContent(e.target.value)}
                        rows={3}
                        className="w-full bg-slate-600 text-white text-sm rounded px-2 py-1 border border-slate-500 resize-none"
                        aria-label="Edit template content"
                      />
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={saveEdit}
                          disabled={!editName.trim() || !editContent.trim()}
                          className="bg-blue-600 hover:bg-blue-500 disabled:bg-slate-600 disabled:text-gray-500 text-white text-xs px-2 py-1 rounded"
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={cancelEdit}
                          className="bg-slate-600 hover:bg-slate-500 text-gray-300 text-xs px-2 py-1 rounded"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-start justify-between">
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium text-white">{template.name}</div>
                          <div className="text-xs text-gray-400 mt-0.5 truncate">{template.content}</div>
                        </div>
                        <div className="flex items-center gap-1 ml-2 shrink-0">
                          <button
                            type="button"
                            onClick={() => onReorder(index, index - 1)}
                            disabled={index === 0}
                            className={cn(
                              'text-xs px-1.5 py-0.5 rounded',
                              index === 0
                                ? 'text-gray-600 cursor-not-allowed'
                                : 'text-gray-400 hover:text-white hover:bg-slate-600',
                            )}
                            aria-label={`Move ${template.name} up`}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            onClick={() => onReorder(index, index + 1)}
                            disabled={index === templates.length - 1}
                            className={cn(
                              'text-xs px-1.5 py-0.5 rounded',
                              index === templates.length - 1
                                ? 'text-gray-600 cursor-not-allowed'
                                : 'text-gray-400 hover:text-white hover:bg-slate-600',
                            )}
                            aria-label={`Move ${template.name} down`}
                          >
                            ↓
                          </button>
                          <button
                            type="button"
                            onClick={() => startEdit(template)}
                            className="text-gray-400 hover:text-white text-xs px-1.5 py-0.5 rounded hover:bg-slate-600"
                            aria-label={`Edit ${template.name}`}
                          >
                            Edit
                          </button>
                          {deleteConfirmId === template.id ? (
                            <div className="flex gap-1">
                              <button
                                type="button"
                                onClick={() => handleDelete(template.id)}
                                className="text-red-400 hover:text-red-300 text-xs px-1.5 py-0.5 rounded hover:bg-slate-600"
                              >
                                Confirm
                              </button>
                              <button
                                type="button"
                                onClick={() => setDeleteConfirmId(null)}
                                className="text-gray-400 hover:text-white text-xs px-1.5 py-0.5 rounded hover:bg-slate-600"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setDeleteConfirmId(template.id)}
                              className="text-gray-400 hover:text-red-400 text-xs px-1.5 py-0.5 rounded hover:bg-slate-600"
                              aria-label={`Delete ${template.name}`}
                            >
                              Delete
                            </button>
                          )}
                        </div>
                      </div>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {templates.length === 0 && (
          <p className="text-sm text-gray-400">No templates yet. Add one above to get started.</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
