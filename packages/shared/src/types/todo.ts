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
  /**
   * The human whose decision this is. For an agent-recorded resolution: the
   * person the agent attributes the quoted words to.
   */
  resolvedByUserId: string | null;
  /** The agent worker that recorded a human's statement; null when a human resolved the item in the UI. */
  resolvedByWorkerId: string | null;
  resolvedAt: string | null;
  /** Comments on the item, never moves; a derived count, not a stored column. */
  commentCount: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Kinds of activity on an item's timeline. The closed list is the client's
 * exhaustiveness constant; each kind has its own table (`todo_comments`,
 * `todo_moves`) and its own member of {@link TodoActivity}.
 */
export const TODO_ACTIVITY_KINDS = ['comment', 'moved'] as const;
export type TodoActivityKind = (typeof TODO_ACTIVITY_KINDS)[number];

/** Who acted: a human in the UI or an agent worker through MCP, never both. */
export type TodoActivityActor = { userId: string } | { workerId: string };

/** Words left on an item by a human (UI) or by an agent of the item's session (MCP). */
export interface TodoCommentActivity {
  id: string;
  todoId: string;
  kind: 'comment';
  actor: TodoActivityActor;
  text: string;
  createdAt: string;
}

/**
 * A change of the item's session. `statement` is the human's quoted
 * instruction when an agent moved the item on it (null when none was given);
 * `attributedUserId` names whose words they are and is set only with a
 * statement.
 */
export interface TodoMoveActivity {
  id: string;
  todoId: string;
  kind: 'moved';
  actor: TodoActivityActor;
  /** Null when the item had no session before the move. */
  fromSessionId: string | null;
  toSessionId: string;
  statement: string | null;
  attributedUserId: string | null;
  createdAt: string;
}

/** One entry of an item's timeline, discriminated by `kind`. */
export type TodoActivity = TodoCommentActivity | TodoMoveActivity;
