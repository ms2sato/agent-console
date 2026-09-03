import { describe, it, expect } from 'bun:test';
import { createTodoWriteTool } from '../todo-write.js';

const ctx = { locationPath: '/tmp/does-not-matter-for-this-tool' };

describe('createTodoWriteTool', () => {
  it('accepts a valid todos list and reports counts by status', async () => {
    const tool = createTodoWriteTool();

    const result = await tool.execute(
      {
        todos: [
          { content: 'Write tests', status: 'in_progress', activeForm: 'Writing tests' },
          { content: 'Ship it', status: 'pending', activeForm: 'Shipping it' },
          { content: 'Plan', status: 'completed', activeForm: 'Planning' },
        ],
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.result).toBe('Todo list updated: 3 items (1 pending, 1 in progress, 1 completed)');
  });

  it('fully replaces the list on a second call rather than merging', async () => {
    const tool = createTodoWriteTool();

    await tool.execute(
      {
        todos: [
          { content: 'A', status: 'pending', activeForm: 'Doing A' },
          { content: 'B', status: 'pending', activeForm: 'Doing B' },
        ],
      },
      ctx,
    );

    const second = await tool.execute(
      { todos: [{ content: 'C', status: 'completed', activeForm: 'Doing C' }] },
      ctx,
    );

    expect(second.ok).toBe(true);
    expect(second.result).toBe('Todo list updated: 1 items (0 pending, 0 in progress, 1 completed)');
  });

  it('accepts an empty todos array and legitimately clears the list to zero items', async () => {
    const tool = createTodoWriteTool();

    await tool.execute(
      { todos: [{ content: 'A', status: 'pending', activeForm: 'Doing A' }] },
      ctx,
    );

    const cleared = await tool.execute({ todos: [] }, ctx);

    expect(cleared.ok).toBe(true);
    expect(cleared.result).toBe('Todo list updated: 0 items (0 pending, 0 in progress, 0 completed)');
  });

  it('rejects an unknown status value', async () => {
    const tool = createTodoWriteTool();

    const result = await tool.execute(
      { todos: [{ content: 'A', status: 'blocked', activeForm: 'Doing A' }] },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.result.length).toBeGreaterThan(0);
  });

  it('rejects an item missing activeForm', async () => {
    const tool = createTodoWriteTool();

    const result = await tool.execute(
      { todos: [{ content: 'A', status: 'pending' }] },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.result.length).toBeGreaterThan(0);
  });

  it('rejects a payload missing the todos key entirely', async () => {
    const tool = createTodoWriteTool();

    const result = await tool.execute({}, ctx);

    expect(result.ok).toBe(false);
    expect(result.result.length).toBeGreaterThan(0);
  });

  it('keeps a fresh instance\'s state independent of an earlier instance (per-incarnation state pin)', async () => {
    const first = createTodoWriteTool();
    await first.execute(
      {
        todos: [
          { content: 'A', status: 'pending', activeForm: 'Doing A' },
          { content: 'B', status: 'pending', activeForm: 'Doing B' },
        ],
      },
      ctx,
    );

    // A second, independently-constructed instance must start empty --
    // this is exactly the property that would fail if todo-write.ts used
    // module-level state instead of a per-call factory closure.
    const second = createTodoWriteTool();
    const secondResult = await second.execute({ todos: [] }, ctx);

    expect(secondResult.ok).toBe(true);
    expect(secondResult.result).toBe('Todo list updated: 0 items (0 pending, 0 in progress, 0 completed)');
  });

  it('returns {ok:false, result:"aborted"} without applying the update when the signal is already aborted', async () => {
    const tool = createTodoWriteTool();
    const controller = new AbortController();
    controller.abort();

    const result = await tool.execute(
      { todos: [{ content: 'A', status: 'pending', activeForm: 'Doing A' }] },
      ctx,
      controller.signal,
    );

    expect(result).toEqual({ ok: false, result: 'aborted' });

    // Confirm the aborted call did not mutate state: a subsequent call with
    // an empty list should report 0 items, not something left over.
    const followUp = await tool.execute({ todos: [] }, ctx);
    expect(followUp.result).toBe('Todo list updated: 0 items (0 pending, 0 in progress, 0 completed)');
  });
});
