import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { renderHook, act, cleanup } from '@testing-library/react';
import {
  useMessageTemplates,
  _resetTemplates,
  _setTemplatesForTest,
  type MessageTemplate,
} from '../useMessageTemplates';

const STORAGE_KEY = 'agent-console:message-templates';

describe('useMessageTemplates', () => {
  beforeEach(() => {
    localStorage.clear();
    _resetTemplates();
  });

  afterEach(() => {
    cleanup();
  });

  it('starts with empty templates when localStorage is empty', () => {
    const { result } = renderHook(() => useMessageTemplates());
    expect(result.current.templates).toEqual([]);
  });

  it('adds a template', () => {
    const { result } = renderHook(() => useMessageTemplates());

    act(() => {
      result.current.addTemplate('Greeting', 'Hello, world!');
    });

    expect(result.current.templates).toHaveLength(1);
    expect(result.current.templates[0].name).toBe('Greeting');
    expect(result.current.templates[0].content).toBe('Hello, world!');
    expect(result.current.templates[0].id).toBeTruthy();
  });

  it('updates a template', () => {
    const { result } = renderHook(() => useMessageTemplates());

    act(() => {
      result.current.addTemplate('Old Name', 'Old content');
    });

    const id = result.current.templates[0].id;

    act(() => {
      result.current.updateTemplate(id, { name: 'New Name', content: 'New content' });
    });

    expect(result.current.templates[0].name).toBe('New Name');
    expect(result.current.templates[0].content).toBe('New content');
    expect(result.current.templates[0].id).toBe(id);
  });

  it('updates only the specified fields', () => {
    const { result } = renderHook(() => useMessageTemplates());

    act(() => {
      result.current.addTemplate('Name', 'Content');
    });

    const id = result.current.templates[0].id;

    act(() => {
      result.current.updateTemplate(id, { name: 'Updated Name' });
    });

    expect(result.current.templates[0].name).toBe('Updated Name');
    expect(result.current.templates[0].content).toBe('Content');
  });

  it('deletes a template', () => {
    const { result } = renderHook(() => useMessageTemplates());

    act(() => {
      result.current.addTemplate('Template 1', 'Content 1');
      result.current.addTemplate('Template 2', 'Content 2');
    });

    const idToDelete = result.current.templates[0].id;

    act(() => {
      result.current.deleteTemplate(idToDelete);
    });

    expect(result.current.templates).toHaveLength(1);
    expect(result.current.templates[0].name).toBe('Template 2');
  });

  it('reorders templates', () => {
    const { result } = renderHook(() => useMessageTemplates());

    act(() => {
      result.current.addTemplate('A', 'Content A');
      result.current.addTemplate('B', 'Content B');
      result.current.addTemplate('C', 'Content C');
    });

    act(() => {
      result.current.reorderTemplates(0, 2);
    });

    expect(result.current.templates[0].name).toBe('B');
    expect(result.current.templates[1].name).toBe('C');
    expect(result.current.templates[2].name).toBe('A');
  });

  it('ignores reorder with out-of-bounds indices', () => {
    const { result } = renderHook(() => useMessageTemplates());

    act(() => {
      result.current.addTemplate('A', 'Content A');
      result.current.addTemplate('B', 'Content B');
    });

    act(() => {
      result.current.reorderTemplates(-1, 0);
    });

    expect(result.current.templates[0].name).toBe('A');
    expect(result.current.templates[1].name).toBe('B');

    act(() => {
      result.current.reorderTemplates(0, 5);
    });

    expect(result.current.templates[0].name).toBe('A');
    expect(result.current.templates[1].name).toBe('B');
  });

  it('persists templates to localStorage', () => {
    const { result } = renderHook(() => useMessageTemplates());

    act(() => {
      result.current.addTemplate('Persisted', 'Saved content');
    });

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(stored).toHaveLength(1);
    expect(stored[0].name).toBe('Persisted');
    expect(stored[0].content).toBe('Saved content');
  });

  it('loads templates from localStorage on init', () => {
    const existing: MessageTemplate[] = [
      { id: 'test-id-1', name: 'Existing', content: 'From storage' },
    ];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(existing));
    _setTemplatesForTest(existing);

    const { result } = renderHook(() => useMessageTemplates());
    expect(result.current.templates).toHaveLength(1);
    expect(result.current.templates[0].name).toBe('Existing');
  });

  it('handles empty localStorage gracefully', () => {
    localStorage.setItem(STORAGE_KEY, '');
    _resetTemplates();

    const { result } = renderHook(() => useMessageTemplates());
    expect(result.current.templates).toEqual([]);
  });

  it('handles corrupt localStorage gracefully', () => {
    localStorage.setItem(STORAGE_KEY, 'not valid json {{{');
    _resetTemplates();

    const { result } = renderHook(() => useMessageTemplates());
    expect(result.current.templates).toEqual([]);
  });

  it('handles non-array localStorage data gracefully', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ not: 'an array' }));
    _resetTemplates();

    const { result } = renderHook(() => useMessageTemplates());
    expect(result.current.templates).toEqual([]);
  });

  it('filters out invalid items from localStorage', () => {
    const mixed = [
      { id: 'valid', name: 'Valid', content: 'Good' },
      { id: 123, name: 'Bad ID', content: 'Missing string id' },
      { name: 'No ID', content: 'Missing id field' },
      null,
    ];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(mixed));
    _setTemplatesForTest(mixed.filter(
      (item): item is MessageTemplate =>
        typeof item === 'object' &&
        item !== null &&
        typeof item.id === 'string' &&
        typeof item.name === 'string' &&
        typeof item.content === 'string',
    ));

    const { result } = renderHook(() => useMessageTemplates());
    expect(result.current.templates).toHaveLength(1);
    expect(result.current.templates[0].name).toBe('Valid');
  });
});
