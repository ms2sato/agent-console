/**
 * Human TODO list routes (docs/design/human-todo-list.md).
 *
 * Mounted inside the `/api` mount AFTER `.use('*', authMiddleware)`, so
 * `authUser` comes only from that middleware. Authorization is the team-tool
 * rule: any authenticated member may list, create, edit, resolve, dismiss and
 * delete any item. Agents have no REST path; their tools are in
 * `mcp/mcp-server.ts` and never resolve, dismiss, delete or re-scope.
 */
import { Hono } from 'hono';
import * as v from 'valibot';
import type { AppBindings } from '../app-context.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import { emitTodosUpdated } from '../lib/todo-triggers.js';
import { vQueryValidator, vValidator } from '../middleware/validation.js';
import type { UpdateTodoParams } from '../repositories/todo-repository.js';
import {
  CreateTodoRequestSchema,
  ResolveTodoRequestSchema,
  TODO_SCOPES,
  TODO_STATUSES,
  UpdateTodoRequestSchema,
} from '@agent-console/shared';

const ListTodosQuerySchema = v.object({
  status: v.optional(v.picklist(TODO_STATUSES)),
  scope: v.optional(v.picklist(TODO_SCOPES)),
  assignee: v.optional(v.pipe(v.string(), v.minLength(1))),
  sessionId: v.optional(v.pipe(v.string(), v.minLength(1))),
});

const todos = new Hono<AppBindings>()
  .get('/', vQueryValidator(ListTodosQuerySchema), async (c) => {
    const { todoRepository } = c.get('appContext');
    const query = c.req.valid('query');
    const list = await todoRepository.list({
      status: query.status,
      scope: query.scope,
      assigneeUserId: query.assignee,
      sessionId: query.sessionId,
    });
    return c.json({ todos: list });
  })
  // Human create. An explicit `scope` wins; otherwise `session` when the
  // request carries a sessionId (the per-session panel) and `global` when it
  // does not (the global page).
  .post('/', vValidator(CreateTodoRequestSchema), async (c) => {
    const body = c.req.valid('json');
    const { todoRepository, broadcastToApp } = c.get('appContext');
    const authUser = c.get('authUser');

    const scope = body.scope ?? (body.sessionId ? 'session' : 'global');
    if (body.kind === 'question' && scope === 'global') {
      throw new ValidationError('A question is always session-scoped: scope "global" is not allowed for kind "question"');
    }
    if (scope === 'session' && !body.sessionId) {
      throw new ValidationError('sessionId is required for a session-scoped item');
    }

    const todo = await todoRepository.create({
      id: crypto.randomUUID(),
      kind: body.kind,
      scope,
      title: body.title,
      body: body.body,
      sessionId: body.sessionId ?? null,
      createdBy: { userId: authUser.id },
      assigneeUserId: body.assigneeUserId ?? null,
    });

    emitTodosUpdated(broadcastToApp, todo.sessionId);
    return c.json({ todo }, 201);
  })
  .patch('/:id', vValidator(UpdateTodoRequestSchema), async (c) => {
    const id = c.req.param('id');
    const body = c.req.valid('json');
    const { todoRepository, broadcastToApp } = c.get('appContext');

    const existing = await todoRepository.findById(id);
    if (!existing) throw new NotFoundError('Todo');
    if (existing.status !== 'open') {
      throw new ConflictError(`Only an open item can be edited (this one is ${existing.status})`);
    }

    const patch: UpdateTodoParams = {
      title: body.title,
      body: body.body,
      assigneeUserId: body.assigneeUserId,
    };

    const reScoping = body.scope !== undefined && body.scope !== existing.scope;
    if (body.sessionId !== undefined && !(reScoping && body.scope === 'session')) {
      throw new ValidationError('sessionId can only be passed when re-scoping an item from global to session');
    }
    if (reScoping) {
      if (existing.kind === 'question') {
        throw new ValidationError('A question cannot be re-scoped: it is always session-scoped');
      }
      if (body.scope === 'session') {
        const sessionId = body.sessionId ?? existing.sessionId;
        if (!sessionId) {
          throw new ValidationError('Re-scoping to "session" needs a sessionId: the item has none stored and none was passed');
        }
        patch.sessionId = sessionId;
      }
      patch.scope = body.scope;
    }

    const updated = await todoRepository.update(id, patch);
    if (!updated) {
      // Resolved or deleted between the read and the write.
      throw new ConflictError('The item is no longer open');
    }

    emitTodosUpdated(broadcastToApp, updated.sessionId);
    if (existing.sessionId !== updated.sessionId) {
      emitTodosUpdated(broadcastToApp, existing.sessionId);
    }
    return c.json({ todo: updated });
  })
  // Resolve. A second resolution of a done item appends its text and moves
  // `resolvedAt`; the status stays `done`.
  .post('/:id/resolve', vValidator(ResolveTodoRequestSchema), async (c) => {
    const id = c.req.param('id');
    const body = c.req.valid('json');
    const { todoRepository, broadcastToApp } = c.get('appContext');
    const authUser = c.get('authUser');

    const existing = await todoRepository.findById(id);
    if (!existing) throw new NotFoundError('Todo');
    if (existing.status !== 'open' && existing.status !== 'done') {
      throw new ConflictError(`An item that is ${existing.status} cannot be resolved`);
    }
    const text = (body.text ?? '').trim();
    if (existing.kind === 'question' && text === '') {
      throw new ValidationError('Resolving a question requires a non-empty text (the answer)');
    }

    const resolved = await todoRepository.resolve(id, { text, resolvedByUserId: authUser.id });
    if (!resolved) {
      throw new ConflictError('The item can no longer be resolved');
    }

    emitTodosUpdated(broadcastToApp, resolved.sessionId);
    return c.json({ todo: resolved });
  })
  .post('/:id/dismiss', async (c) => {
    const id = c.req.param('id');
    const { todoRepository, broadcastToApp } = c.get('appContext');

    const existing = await todoRepository.findById(id);
    if (!existing) throw new NotFoundError('Todo');
    if (existing.status !== 'open') {
      throw new ConflictError(`Only an open item can be dismissed (this one is ${existing.status})`);
    }

    const dismissed = await todoRepository.dismiss(id);
    if (!dismissed) {
      throw new ConflictError('The item is no longer open');
    }

    emitTodosUpdated(broadcastToApp, dismissed.sessionId);
    return c.json({ todo: dismissed });
  })
  .delete('/:id', async (c) => {
    const id = c.req.param('id');
    const { todoRepository, broadcastToApp } = c.get('appContext');

    const existing = await todoRepository.findById(id);
    if (!existing) throw new NotFoundError('Todo');

    const deleted = await todoRepository.delete(id);
    if (!deleted) throw new NotFoundError('Todo');

    emitTodosUpdated(broadcastToApp, existing.sessionId);
    return c.json({ success: true });
  });

export { todos };
