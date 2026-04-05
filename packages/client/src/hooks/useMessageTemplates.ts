import { useSyncExternalStore } from 'react';

export interface MessageTemplate {
  id: string;
  name: string;
  content: string;
}

const STORAGE_KEY = 'agent-console:message-templates';

type Listener = () => void;

let templates: MessageTemplate[] = loadFromStorage();
const listeners = new Set<Listener>();

function loadFromStorage(): MessageTemplate[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item: unknown): item is MessageTemplate =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as MessageTemplate).id === 'string' &&
        typeof (item as MessageTemplate).name === 'string' &&
        typeof (item as MessageTemplate).content === 'string',
    );
  } catch {
    return [];
  }
}

function persist(): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(templates));
}

function emitChange(): void {
  persist();
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): MessageTemplate[] {
  return templates;
}

function addTemplate(name: string, content: string): void {
  templates = [...templates, { id: crypto.randomUUID(), name, content }];
  emitChange();
}

function updateTemplate(id: string, updates: Partial<Pick<MessageTemplate, 'name' | 'content'>>): void {
  templates = templates.map(t => (t.id === id ? { ...t, ...updates } : t));
  emitChange();
}

function deleteTemplate(id: string): void {
  templates = templates.filter(t => t.id !== id);
  emitChange();
}

function reorderTemplates(fromIndex: number, toIndex: number): void {
  if (fromIndex < 0 || fromIndex >= templates.length || toIndex < 0 || toIndex >= templates.length) return;
  const next = [...templates];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  templates = next;
  emitChange();
}

export function useMessageTemplates() {
  const currentTemplates = useSyncExternalStore(subscribe, getSnapshot);
  return {
    templates: currentTemplates,
    addTemplate,
    updateTemplate,
    deleteTemplate,
    reorderTemplates,
  } as const;
}

/** @internal Exported for testing */
export function _resetTemplates(): void {
  templates = [];
  persist();
  emitChange();
}

/** @internal Exported for testing */
export function _setTemplatesForTest(newTemplates: MessageTemplate[]): void {
  templates = newTemplates;
  emitChange();
}
