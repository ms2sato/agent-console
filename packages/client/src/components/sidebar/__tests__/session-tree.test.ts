import { describe, it, expect } from 'bun:test';
import type { AgentActivityState, Session } from '@agent-console/shared';
import type { SessionWithActivity } from '../../../hooks/useActiveSessionsWithActivity';
import { buildSessionTree, type SessionTreeNode } from '../session-tree';

function item(
  id: string,
  activityState: AgentActivityState = 'idle',
  extra: { parentSessionId?: string; title?: string } = {}
): SessionWithActivity {
  return {
    activityState,
    session: {
      id,
      type: 'quick' as const,
      locationPath: '/p',
      status: 'active',
      activationState: 'running',
      createdAt: '2026-01-01T00:00:00.000Z',
      workers: [],
      isShared: false,
      recoveryState: 'healthy',
      ...extra,
    } satisfies Session,
  };
}

const ids = (nodes: SessionTreeNode[]) => nodes.map((n) => n.item.session.id);

describe('buildSessionTree', () => {
  it('returns an empty forest for an empty list', () => {
    expect(buildSessionTree([])).toEqual([]);
  });

  it('returns a single root that is not an orphan', () => {
    const tree = buildSessionTree([item('a')]);
    expect(tree).toHaveLength(1);
    expect(tree[0].item.session.id).toBe('a');
    expect(tree[0].children).toEqual([]);
    expect(tree[0].orphan).toBe(false);
  });

  it('nests a child under its parent', () => {
    const tree = buildSessionTree([item('child', 'idle', { parentSessionId: 'root' }), item('root')]);
    expect(ids(tree)).toEqual(['root']);
    expect(ids(tree[0].children)).toEqual(['child']);
    expect(tree[0].children[0].orphan).toBe(false);
  });

  it('shows a child whose parent is absent as an orphan root', () => {
    const tree = buildSessionTree([item('lost', 'idle', { parentSessionId: 'gone' }), item('ok')]);
    expect(ids(tree).sort()).toEqual(['lost', 'ok']);
    expect(tree.find((n) => n.item.session.id === 'lost')!.orphan).toBe(true);
    expect(tree.find((n) => n.item.session.id === 'ok')!.orphan).toBe(false);
  });

  it('turns both members of a parent cycle into orphan roots without looping', () => {
    const tree = buildSessionTree([
      item('a', 'idle', { parentSessionId: 'b' }),
      item('b', 'idle', { parentSessionId: 'a' }),
    ]);
    expect(ids(tree).sort()).toEqual(['a', 'b']);
    expect(tree.every((n) => n.orphan && n.children.length === 0)).toBe(true);
  });

  it('treats a session that is its own parent as an orphan root', () => {
    const tree = buildSessionTree([item('a', 'idle', { parentSessionId: 'a' })]);
    expect(ids(tree)).toEqual(['a']);
    expect(tree[0].orphan).toBe(true);
  });

  it('keeps a tail hanging off a cycle under the cycle member', () => {
    const tree = buildSessionTree([
      item('a', 'idle', { parentSessionId: 'b' }),
      item('b', 'idle', { parentSessionId: 'a' }),
      item('tail', 'idle', { parentSessionId: 'a' }),
    ]);
    const a = tree.find((n) => n.item.session.id === 'a')!;
    expect(ids(a.children)).toEqual(['tail']);
    expect(a.children[0].orphan).toBe(false);
  });

  it('nests to depth 3 recursively', () => {
    const tree = buildSessionTree([
      item('c', 'idle', { parentSessionId: 'b' }),
      item('b', 'idle', { parentSessionId: 'a' }),
      item('a'),
    ]);
    expect(ids(tree)).toEqual(['a']);
    expect(ids(tree[0].children)).toEqual(['b']);
    expect(ids(tree[0].children[0].children)).toEqual(['c']);
  });

  it('orders children by activity priority, then title, then id', () => {
    const tree = buildSessionTree([
      item('root'),
      item('k-active', 'active', { parentSessionId: 'root', title: 'a' }),
      item('k-idle-z', 'idle', { parentSessionId: 'root', title: 'z' }),
      item('k-asking', 'asking', { parentSessionId: 'root', title: 'm' }),
      item('k-idle-b2', 'idle', { parentSessionId: 'root', title: 'b' }),
      item('k-idle-b1', 'idle', { parentSessionId: 'root', title: 'b' }),
    ]);
    expect(ids(tree[0].children)).toEqual([
      'k-asking',
      'k-idle-b1',
      'k-idle-b2',
      'k-idle-z',
      'k-active',
    ]);
  });

  it('orders roots by activity priority and keeps input order on ties', () => {
    const tree = buildSessionTree([item('r-active', 'active'), item('r-idle-2', 'idle'), item('r-asking', 'asking'), item('r-idle-1', 'idle')]);
    expect(ids(tree)).toEqual(['r-asking', 'r-idle-2', 'r-idle-1', 'r-active']);
  });

  it("never lets a node's children reorder the roots", () => {
    const tree = buildSessionTree([
      item('quiet-root', 'idle'),
      item('busy-root', 'active'),
      item('urgent-child', 'asking', { parentSessionId: 'busy-root' }),
    ]);
    expect(ids(tree)).toEqual(['quiet-root', 'busy-root']);
  });
});
