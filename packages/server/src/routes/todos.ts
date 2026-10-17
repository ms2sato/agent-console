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
import type { AppBindings, AppContext } from '../app-context.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { serverConfig } from '../lib/server-config.js';
import { sessionVisibleToUser } from '../lib/session-access.js';
import { deliverTodoComment, deliverTodoResolution, emitTodosUpdated } from '../lib/todo-triggers.js';
import { vQueryValidator, vValidator } from '../middleware/validation.js';
import type { UpdateTodoParams } from '../repositories/todo-repository.js';
import {
  canReceiveNotifications,
  CommentTodoRequestSchema,
  CreateTodoRequestSchema,
  ResolveTodoRequestSchema,
  TODO_SCOPES,
  TODO_STATUSES,
  UpdateTodoRequestSchema,
} from '@agent-console/shared';

const logger = createLogger('api:todos');

const ListTodosQuerySchema = v.object({
  status: v.optional(v.picklist(TODO_STATUSES)),
  scope: v.optional(v.picklist(TODO_SCOPES)),
  assignee: v.optional(v.pipe(v.string(), v.minLength(1))),
  sessionId: v.optional(v.pipe(v.string(), v.minLength(1))),
  // 'mine-and-shared': only items assigned to me, created by me, or in a session I own or that is shared.
  view: v.optional(v.picklist(['mine-and-shared'])),
});

const MoveTodoRequestSchema = v.strictObject({
  sessionId: v.pipe(v.string(), v.minLength(1)),
  workerId: v.optional(v.pipe(v.string(), v.minLength(1))),
});

/**
 * Existence checks for the references a write carries. A persisted (paused)
 * session counts as known. Run AFTER the request's own validation refusals,
 * and before anything is written.
 */
async function assertReferencesExist(
  ctx: Pick<AppContext, 'sessionManager' | 'userRepository'>,
  refs: { sessionId?: string | null; assigneeUserId?: string | null },
): Promise<void> {
  if (refs.sessionId) {
    const known =
      ctx.sessionManager.getSession(refs.sessionId) ??
      (await ctx.sessionManager.getPersistedSession(refs.sessionId));
    if (!known) throw new NotFoundError('Session');
  }
  if (refs.assigneeUserId) {
    const user = await ctx.userRepository.findById(refs.assigneeUserId);
    if (!user) throw new NotFoundError('User');
  }
}

const todos = new Hono<AppBindings>()
  .get('/', vQueryValidator(ListTodosQuerySchema), async (c) => {
    const { todoRepository, sessionManager, sharedAccountRegistry } = c.get('appContext');
    const authUser = c.get('authUser');
    const query = c.req.valid('query');

    // Single-user mode has one user who sees everything, so `view` is accepted and ignored there.
    let visibleTo: { userId: string; sessionIds: string[] } | undefined;
    if (query.view && serverConfig.AUTH_MODE === 'multi-user') {
      // Live and paused sessions both count: a paused session's items stay visible.
      const sessions = [...sessionManager.getAllSessions(), ...(await sessionManager.getAllPersistedSessions())];
      const sessionIds = sessions
        .filter((s) => sessionVisibleToUser(s, authUser.id, sharedAccountRegistry))
        .map((s) => s.id);
      visibleTo = { userId: authUser.id, sessionIds: [...new Set(sessionIds)] };
    }

    const list = await todoRepository.list({
      status: query.status,
      scope: query.scope,
      assigneeUserId: query.assignee,
      sessionId: query.sessionId,
      visibleTo,
    });
    return c.json({ todos: list });
  })
  .get('/:id', async (c) => {
    const { todoRepository } = c.get('appContext');
    const id = c.req.param('id');
    const todo = await todoRepository.findById(id);
    if (!todo) throw new NotFoundError('Todo');
    return c.json({ todo, activities: await todoRepository.listActivities(id) });
  })
  // Human create. An explicit `scope` wins; otherwise `session` when the
  // request carries a sessionId (the per-session panel) and `global` when it
  // does not (the global page).
  .post('/', vValidator(CreateTodoRequestSchema), async (c) => {
    const body = c.req.valid('json');
    const appContext = c.get('appContext');
    const { todoRepository, broadcastToApp } = appContext;
    const authUser = c.get('authUser');

    const scope = body.scope ?? (body.sessionId ? 'session' : 'global');
    if (body.kind === 'question' && scope === 'global') {
      throw new ValidationError('A question is always session-scoped: scope "global" is not allowed for kind "question"');
    }
    if (scope === 'session' && !body.sessionId) {
      throw new ValidationError('sessionId is required for a session-scoped item');
    }

    await assertReferencesExist(appContext, {
      sessionId: body.sessionId,
      assigneeUserId: body.assigneeUserId,
    });

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
    const appContext = c.get('appContext');
    const { todoRepository, broadcastToApp } = appContext;

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

    await assertReferencesExist(appContext, {
      sessionId: patch.sessionId,
      assigneeUserId: body.assigneeUserId,
    });

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
    const { todoRepository, broadcastToApp, sessionManager } = c.get('appContext');
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

    // Best effort and not awaited: the response never depends on the worker.
    const workerId = 'workerId' in resolved.createdBy ? resolved.createdBy.workerId : undefined;
    void deliverTodoResolution(sessionManager, resolved, text)
      .then((result) => {
        if (result && !result.ok) {
          logger.warn(
            { todoId: id, sessionId: resolved.sessionId, workerId, reason: result.reason, error: result.error },
            'Failed to deliver todo resolution',
          );
        }
      })
      .catch((err) => {
        logger.warn({ todoId: id, sessionId: resolved.sessionId, workerId, err }, 'Failed to deliver todo resolution');
      });

    return c.json({ todo: resolved });
  })
  // Comment. Allowed on open and done items only; the status never changes. A human's comment
  // on an agent-created item is delivered to the creating worker.
  .post('/:id/comments', vValidator(CommentTodoRequestSchema), async (c) => {
    const id = c.req.param('id');
    const body = c.req.valid('json');
    const { todoRepository, broadcastToApp, sessionManager } = c.get('appContext');
    const authUser = c.get('authUser');

    const existing = await todoRepository.findById(id);
    if (!existing) throw new NotFoundError('Todo');
    if (existing.status !== 'open' && existing.status !== 'done') {
      throw new ConflictError(`An item that is ${existing.status} cannot take a comment`);
    }

    const added = await todoRepository.addComment({ todoId: id, actor: { userId: authUser.id }, text: body.text });
    if (!added) {
      // The conditional insert wrote nothing: the item was deleted or closed since the read above.
      const current = await todoRepository.findById(id);
      if (!current) throw new NotFoundError('Todo');
      throw new ConflictError(`An item that is ${current.status} cannot take a comment`);
    }
    const [todo, activities] = await Promise.all([todoRepository.findById(id), todoRepository.listActivities(id)]);
    if (!todo) {
      // Deleted between the write and the read: the comment went with it.
      throw new NotFoundError('Todo');
    }

    emitTodosUpdated(broadcastToApp, todo.sessionId);

    // Best effort and not awaited: the response never depends on the worker.
    const workerId = 'workerId' in todo.createdBy ? todo.createdBy.workerId : undefined;
    void deliverTodoComment(sessionManager, todo, authUser.username, body.text)
      .then((result) => {
        if (result && !result.ok) {
          logger.warn(
            { todoId: id, sessionId: todo.sessionId, workerId, reason: result.reason, error: result.error },
            'Failed to deliver todo comment',
          );
        }
      })
      .catch((err) => {
        logger.warn({ todoId: id, sessionId: todo.sessionId, workerId, err }, 'Failed to deliver todo comment');
      });

    return c.json({ todo, activities });
  })
  // Move an open item to another LIVE session (its delivery needs a live worker). A move is not a
  // resolution: nothing is delivered. Team-tool rule: any member may, no session-ownership check.
  .post('/:id/move', vValidator(MoveTodoRequestSchema), async (c) => {
    const id = c.req.param('id');
    const body = c.req.valid('json');
    const { todoRepository, broadcastToApp, sessionManager } = c.get('appContext');
    const authUser = c.get('authUser');

    const todo = await todoRepository.findById(id);
    if (!todo) throw new NotFoundError('Todo');
    if (todo.status !== 'open') {
      throw new ConflictError(`Only an open item can be moved (this one is ${todo.status})`);
    }

    const target = sessionManager.getSession(body.sessionId);
    if (!target) {
      const paused = await sessionManager.getPersistedSession(body.sessionId);
      if (paused) throw new ConflictError('Target session is paused; resume it first');
      throw new NotFoundError('Session');
    }

    // The worker that will hear the resolution. A human-created item has none and keeps none.
    let workerId: string | null = null;
    if ('workerId' in todo.createdBy) {
      if (body.workerId !== undefined) {
        const worker = target.workers.find((w) => w.id === body.workerId);
        if (!worker) {
          throw new ConflictError(`Worker ${body.workerId} not found in session ${body.sessionId}`);
        }
        if (!canReceiveNotifications(worker)) {
          throw new ConflictError(
            `Worker ${body.workerId} in session ${body.sessionId} cannot receive notifications: requires an agent, terminal, or embedded-agent worker`,
          );
        }
        workerId = worker.id;
      } else {
        const worker = target.workers.find(canReceiveNotifications);
        if (!worker) throw new ConflictError('Target session has no worker that can receive notifications');
        workerId = worker.id;
      }
    } else if (body.workerId !== undefined) {
      throw new ValidationError('a human-created item has no delivery worker');
    }

    // Already in that session. Human-created, or the same worker: a read-only no-op. A different worker
    // of the same session takes over delivery below: the row is updated, but it is not a move.
    const sameSession = todo.sessionId === body.sessionId;
    if (sameSession && (workerId === null || ('workerId' in todo.createdBy && todo.createdBy.workerId === workerId))) {
      return c.json({ todo });
    }

    const moved = await todoRepository.adopt(id, {
      sessionId: body.sessionId,
      workerId,
      expectedSessionId: todo.sessionId,
      expectedWorkerId: 'workerId' in todo.createdBy ? todo.createdBy.workerId : null,
      actor: { userId: authUser.id },
    });
    if (!moved) {
      // The write is a compare-and-set on the session the item was read in; say which condition failed.
      const current = await todoRepository.findById(id);
      if (!current) throw new NotFoundError('Todo');
      if (current.status !== 'open') {
        throw new ConflictError(`Only an open item can be moved (this one is ${current.status})`);
      }
      throw new ConflictError('The item moved while you were moving it; reload');
    }

    if (!sameSession) {
      emitTodosUpdated(broadcastToApp, todo.sessionId);
    }
    emitTodosUpdated(broadcastToApp, moved.sessionId);
    return c.json({ todo: moved });
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
