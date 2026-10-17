/**
 * Closed lists of a human TODO item's `kind`, `scope` and `status`
 * (`docs/design/human-todo-list.md` section 2). The lists are the
 * scope-creep guard: a new member is a deliberate edit here, mirrored by
 * the SQL CHECK constraints of the `todos` table. The wire shapes built on
 * these lists live in `schemas/todo.ts`.
 */
export const TODO_KINDS = ['question', 'action'] as const;
export type TodoKind = (typeof TODO_KINDS)[number];

export const TODO_SCOPES = ['session', 'global'] as const;
export type TodoScope = (typeof TODO_SCOPES)[number];

export const TODO_STATUSES = ['open', 'done', 'superseded', 'dismissed', 'withdrawn'] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

/**
 * Kinds of activity on an item's timeline. The closed list is the client's
 * exhaustiveness constant; each kind has its own table (`todo_comments`,
 * `todo_moves`) and its own member of the `TodoActivity` union in `schemas/todo.ts`.
 */
export const TODO_ACTIVITY_KINDS = ['comment', 'moved'] as const;
export type TodoActivityKind = (typeof TODO_ACTIVITY_KINDS)[number];
