/**
 * Record a global human TODO item for every session row that needs an
 * operator's attention -- a row `SessionRepository.findAll()`
 * cannot hydrate ("unreadable"), or a row marked `recoveryState ===
 * 'orphaned'` ("Session Unrecoverable" in the UI). Each row gets exactly
 * one item, named by `sessionAttentionTodoId`; the item is auto-withdrawn
 * once the row is gone or no longer needs attention. Called once at boot
 * (see `app-context.ts`'s `createAppContext` / `createTestContext`) -- not
 * from `SessionInitializationService`, which hydrates sessions and would
 * never observe an unreadable row in the first place.
 */
import type { SessionRepository, SessionRef } from '../repositories/session-repository.js';
import type { TodoRepository } from '../repositories/todo-repository.js';
import type { UserRepository } from '../repositories/user-repository.js';
import {
  sessionAttentionTodoId,
  SESSION_ATTENTION_TODO_ID_PREFIX,
  SESSION_DELETE_REMOVES_HEADING,
  SESSION_DELETE_REMOVES,
  SESSION_DELETE_KEEPS_HEADING,
  SESSION_DELETE_KEEPS,
  SESSION_DELETE_UNRESOLVED_NOTE,
} from '@agent-console/shared';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('session-attention-recorder');

export interface SessionAttentionRecorderDeps {
  sessionRepository: SessionRepository;
  todoRepository: TodoRepository;
  userRepository: UserRepository;
  getRepositoryName: (id: string) => string | undefined;
}

type AttentionKind = 'unreadable' | 'orphaned';

/**
 * Create (or leave alone) one attention item per session needing attention,
 * and withdraw every previously-recorded item whose session no longer
 * needs one. Never throws: a failure anywhere in this pass is logged and
 * boot continues, per decision B10.
 */
export async function recordSessionsNeedingAttention(deps: SessionAttentionRecorderDeps): Promise<void> {
  try {
    const [refs, readable] = await Promise.all([
      deps.sessionRepository.findAllSessionRefs(),
      deps.sessionRepository.findAll(),
    ]);
    const readableIds = new Set(readable.map((s) => s.id));

    const unreadableRefs = refs.filter((r) => !readableIds.has(r.id));
    const orphanedRefs = refs.filter((r) => readableIds.has(r.id) && r.recoveryState === 'orphaned');
    const needsAttentionIds = new Set([...unreadableRefs, ...orphanedRefs].map((r) => r.id));

    let created = 0;
    let unattributed = 0;

    for (const ref of unreadableRefs) {
      created += await tryEnsureAttentionItem(deps, ref, 'unreadable', () => unattributed++);
    }
    for (const ref of orphanedRefs) {
      created += await tryEnsureAttentionItem(deps, ref, 'orphaned', () => unattributed++);
    }

    let withdrawn = 0;
    const openGlobalItems = await deps.todoRepository.list({ status: 'open', scope: 'global' });
    for (const item of openGlobalItems) {
      if (!item.id.startsWith(SESSION_ATTENTION_TODO_ID_PREFIX)) continue;
      const sessionId = item.id.slice(SESSION_ATTENTION_TODO_ID_PREFIX.length);
      if (needsAttentionIds.has(sessionId)) continue;
      try {
        if (await deps.todoRepository.withdrawOpenById(item.id)) withdrawn++;
      } catch (err) {
        logger.warn({ todoId: item.id, err }, 'Failed to withdraw a stale session-attention item');
      }
    }

    logger.info(
      { unreadable: unreadableRefs.length, orphaned: orphanedRefs.length, created, withdrawn, unattributed },
      'Session-attention boot pass complete',
    );
  } catch (err) {
    logger.error({ err }, 'Session-attention boot pass failed; continuing boot');
  }
}

/** Wraps {@link ensureAttentionItem} so one row's failure never stops the others. Returns 1 if a new item was created, else 0. */
async function tryEnsureAttentionItem(
  deps: SessionAttentionRecorderDeps,
  ref: SessionRef,
  kind: AttentionKind,
  onUnattributed: () => void,
): Promise<number> {
  try {
    const outcome = await ensureAttentionItem(deps, ref, kind);
    if (outcome === 'unattributed') onUnattributed();
    return outcome === 'created' ? 1 : 0;
  } catch (err) {
    logger.warn({ sessionId: ref.id, kind, err }, 'Failed to record attention item for a session needing attention');
    return 0;
  }
}

async function ensureAttentionItem(
  deps: SessionAttentionRecorderDeps,
  ref: SessionRef,
  kind: AttentionKind,
): Promise<'created' | 'exists' | 'unattributed'> {
  const todoId = sessionAttentionTodoId(ref.id);
  if (await deps.todoRepository.findById(todoId)) return 'exists';

  const creator = await resolveCreator(deps.userRepository, ref.createdBy);
  if (!creator) {
    logger.warn({ sessionId: ref.id }, 'Could not attribute a creator for a session-attention item');
    return 'unattributed';
  }

  const title = `Session needs attention: ${ref.title ?? ref.id}`;
  const body = buildAttentionBody(ref, kind, deps.getRepositoryName);
  await deps.todoRepository.create({
    id: todoId,
    kind: 'action',
    scope: 'global',
    title,
    body,
    sessionId: ref.id,
    createdBy: { userId: creator.creatorUserId },
    assigneeUserId: creator.assigneeUserId,
  });
  return 'created';
}

async function resolveCreator(
  userRepository: UserRepository,
  createdBy: string | null,
): Promise<{ creatorUserId: string; assigneeUserId: string | null } | null> {
  if (createdBy) {
    const user = await userRepository.findById(createdBy);
    if (user) return { creatorUserId: user.id, assigneeUserId: user.id };
  }
  const users = await userRepository.findAll();
  if (users.length === 1) return { creatorUserId: users[0].id, assigneeUserId: null };
  return null;
}

function buildAttentionBody(
  ref: SessionRef,
  kind: AttentionKind,
  getRepositoryName: (id: string) => string | undefined,
): string {
  const date = new Date().toISOString().slice(0, 10);
  const reason =
    kind === 'unreadable'
      ? "The session's stored data cannot be read, so it is not shown in the session list."
      : `The session is marked Unrecoverable (${ref.orphanedReason ?? 'unknown'}).`;
  const repositoryLine = buildRepositoryLine(ref.repositoryId, getRepositoryName);
  const closing =
    kind === 'unreadable'
      ? 'There is no delete button for this session yet.'
      : 'To delete it, open the session from the sidebar and press Delete Session.';

  return [
    `Recorded by the server on ${date}.`,
    '',
    `- Reason: ${reason}`,
    `- Session: \`${ref.id}\``,
    `- Repository: ${repositoryLine}`,
    `- Location: \`${ref.locationPath}\``,
    '',
    `**${SESSION_DELETE_REMOVES_HEADING}**`,
    ...SESSION_DELETE_REMOVES.map((s) => `- ${s}`),
    '',
    `**${SESSION_DELETE_KEEPS_HEADING}**`,
    ...SESSION_DELETE_KEEPS.map((s) => `- ${s}`),
    '',
    SESSION_DELETE_UNRESOLVED_NOTE,
    '',
    closing,
  ].join('\n');
}

function buildRepositoryLine(repositoryId: string | null, getRepositoryName: (id: string) => string | undefined): string {
  if (repositoryId === null) return 'none';
  const name = getRepositoryName(repositoryId);
  return name ? `${name} (\`${repositoryId}\`)` : `not registered (\`${repositoryId}\`)`;
}
