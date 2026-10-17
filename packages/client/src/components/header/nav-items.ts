/**
 * The single list of header navigation destinations. The desktop top level,
 * the desktop user menu and the mobile hamburger all render from it; moving an
 * item between the top level and the user menu is a one-line `placement` flip.
 * Logout is an action, not a destination, and is deliberately not listed here.
 */
export interface NavItem {
  id: string;
  label: string;
  to: string;
  /** `top`: always visible on desktop. `menu`: inside the user menu. */
  placement: 'top' | 'menu';
  /** `prefix`: active on the path and everything beneath it. `exact`: only on the path itself. */
  match: 'prefix' | 'exact';
  multiUserOnly?: boolean;
  badge?: 'todo' | 'review';
}

export const NAV_ITEMS: readonly NavItem[] = [
  { id: 'todos', label: 'Todo', to: '/todos', placement: 'top', match: 'prefix', badge: 'todo' },
  { id: 'review', label: 'Review', to: '/review', placement: 'top', match: 'prefix', badge: 'review' },
  { id: 'artifacts', label: 'Artifacts', to: '/artifacts', placement: 'top', match: 'prefix' },
  // Exact match: Repositories lives at /settings/repositories, so a prefix match here
  // would highlight Settings and Repositories together on that path.
  { id: 'settings', label: 'Settings', to: '/settings', placement: 'menu', match: 'exact' },
  { id: 'repositories', label: 'Repositories', to: '/settings/repositories', placement: 'menu', match: 'prefix' },
  { id: 'agents', label: 'Agents', to: '/agents', placement: 'menu', match: 'prefix' },
  { id: 'jobs', label: 'Jobs', to: '/jobs', placement: 'menu', match: 'prefix' },
  {
    id: 'shared-accounts',
    label: 'Shared accounts',
    to: '/settings/shared-accounts',
    placement: 'menu',
    match: 'exact',
    multiUserOnly: true,
  },
];

export function isNavItemActive(item: NavItem, pathname: string): boolean {
  return item.match === 'exact' ? pathname === item.to : pathname.startsWith(item.to);
}

/** Items visible in the current auth mode, in list order. */
export function navItemsForAuthMode(isMultiUser: boolean): NavItem[] {
  return NAV_ITEMS.filter((item) => isMultiUser || !item.multiUserOnly);
}

export function navItemsByPlacement(placement: NavItem['placement'], isMultiUser: boolean): NavItem[] {
  return navItemsForAuthMode(isMultiUser).filter((item) => item.placement === placement);
}
