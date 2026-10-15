/**
 * Closed lists of a human TODO item's `kind`, `scope` and `status`
 * (`docs/design/human-todo-list.md` section 2). The lists are the
 * scope-creep guard: a new member is a deliberate edit here, mirrored by
 * the SQL CHECK constraints of the `todos` table.
 */
export const TODO_KINDS = ['question', 'action'] as const;
export type TodoKind = (typeof TODO_KINDS)[number];

export const TODO_SCOPES = ['session', 'global'] as const;
export type TodoScope = (typeof TODO_SCOPES)[number];

export const TODO_STATUSES = ['open', 'done', 'superseded', 'dismissed', 'withdrawn'] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

/**
 * Who created an item: an agent (the worker is the resolution
 * notification's target) or a human, never both.
 */
export type TodoCreator = { workerId: string } | { userId: string };

/**
 * A TODO item as it crosses the wire. `sessionId` is the item's session:
 * required for `scope = 'session'` and for an agent creator, provenance
 * otherwise (a `global` item may still carry it).
 */
export interface Todo {
  id: string;
  kind: TodoKind;
  scope: TodoScope;
  title: string;
  body: string;
  sessionId: string | null;
  createdBy: TodoCreator;
  assigneeUserId: string | null;
  status: TodoStatus;
  resolutionText: string | null;
  resolvedByUserId: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
