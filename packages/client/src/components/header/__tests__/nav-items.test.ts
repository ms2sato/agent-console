import { describe, it, expect } from 'bun:test';
import { NAV_ITEMS, isNavItemActive, navItemsByPlacement, navItemsForAuthMode, type NavItem } from '../nav-items';

function item(id: string): NavItem {
  const found = NAV_ITEMS.find((i) => i.id === id);
  if (!found) throw new Error(`no nav item ${id}`);
  return found;
}

describe('NAV_ITEMS', () => {
  it('has unique ids', () => {
    const ids = NAV_ITEMS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('places every item at the top level or in the menu', () => {
    for (const i of NAV_ITEMS) {
      expect(['top', 'menu']).toContain(i.placement);
    }
  });

  it('marks only shared-accounts as multi-user only', () => {
    expect(NAV_ITEMS.filter((i) => i.multiUserOnly === true).map((i) => i.id)).toEqual(['shared-accounts']);
  });

  it('carries a badge only on todos and review', () => {
    expect(NAV_ITEMS.filter((i) => i.badge !== undefined).map((i) => [i.id, i.badge])).toEqual([
      ['todos', 'todo'],
      ['review', 'review'],
    ]);
  });

  it('keeps the top group in order: Todo, Review, Artifacts', () => {
    expect(navItemsByPlacement('top', true).map((i) => i.label)).toEqual(['Todo', 'Review', 'Artifacts']);
  });

  it('keeps the menu group in order: Settings, Repositories, Agents, Jobs, Shared accounts', () => {
    expect(navItemsByPlacement('menu', true).map((i) => i.label)).toEqual([
      'Settings',
      'Repositories',
      'Agents',
      'Jobs',
      'Shared accounts',
    ]);
  });

  it('does not list Logout, which is an action', () => {
    expect(NAV_ITEMS.some((i) => /logout/i.test(i.id) || /logout/i.test(i.label))).toBe(false);
  });
});

describe('navItemsForAuthMode', () => {
  it('hides multi-user-only items in single-user mode', () => {
    expect(navItemsForAuthMode(false).map((i) => i.id)).not.toContain('shared-accounts');
    expect(navItemsByPlacement('menu', false).map((i) => i.label)).toEqual(['Settings', 'Repositories', 'Agents', 'Jobs']);
  });

  it('keeps every item in multi-user mode', () => {
    expect(navItemsForAuthMode(true)).toEqual([...NAV_ITEMS]);
  });
});

describe('isNavItemActive', () => {
  it('matches exact items only on their own path', () => {
    expect(isNavItemActive(item('settings'), '/settings')).toBe(true);
    expect(isNavItemActive(item('settings'), '/settings/repositories')).toBe(false);
    expect(isNavItemActive(item('shared-accounts'), '/settings/shared-accounts')).toBe(true);
    expect(isNavItemActive(item('shared-accounts'), '/settings/shared-accounts/x')).toBe(false);
  });

  it('matches prefix items on their path and everything beneath it', () => {
    expect(isNavItemActive(item('repositories'), '/settings/repositories/abc')).toBe(true);
    expect(isNavItemActive(item('settings'), '/settings/repositories/abc')).toBe(false);
    expect(isNavItemActive(item('artifacts'), '/artifacts/x')).toBe(true);
    expect(isNavItemActive(item('jobs'), '/jobs/123')).toBe(true);
    expect(isNavItemActive(item('jobs'), '/agents')).toBe(false);
  });
});
