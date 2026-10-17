import { useEffect } from 'react';
import { Link, useLocation } from '@tanstack/react-router';
import { useAuth } from '../../lib/auth';
import { useLogout } from '../../hooks/useLogout';
import { TodoCountBadge } from './TodoCountBadge';
import { ReviewCountBadge } from './ReviewCountBadge';
import { ValidationWarningIndicator } from './NavLinks';
import { isNavItemActive, navItemsByPlacement, type NavItem } from './nav-items';

interface MobileNavMenuProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Mobile navigation dropdown. Rendered from the shared NAV_ITEMS list: the top
 * group (Todo, Review, Artifacts), the Maintenance warning when issues exist,
 * the menu group (Settings, Repositories, Agents, Jobs, and Shared accounts in
 * multi-user mode), then Logout in multi-user mode.
 */
export function MobileNavMenu({ open, onClose }: MobileNavMenuProps) {
  const location = useLocation();
  const { isMultiUser } = useAuth();
  const { logout, isLoggingOut } = useLogout();

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const renderItem = (item: NavItem) => (
    <NavMenuItem
      key={item.id}
      to={item.to}
      active={isNavItemActive(item, location.pathname)}
      onClick={onClose}
    >
      {item.badge ? (
        <span className="flex items-center gap-1.5">
          {item.label}
          {item.badge === 'todo' ? <TodoCountBadge /> : <ReviewCountBadge />}
        </span>
      ) : (
        item.label
      )}
    </NavMenuItem>
  );

  return (
    <>
      <div className="fixed inset-0 z-30" aria-hidden="true" onClick={onClose} />
      <nav
        aria-label="Main navigation"
        className="absolute right-2 top-full z-40 mt-1 w-48 bg-slate-800 border border-slate-700 rounded-lg shadow-lg py-1"
      >
        {navItemsByPlacement('top', isMultiUser).map(renderItem)}
        {/* The indicator renders nothing without issues; empty:hidden then collapses the row. */}
        <div className="px-4 min-h-[44px] flex items-center empty:hidden" onClick={onClose}>
          <ValidationWarningIndicator />
        </div>
        <MenuSeparator />
        {navItemsByPlacement('menu', isMultiUser).map(renderItem)}
        {isMultiUser && (
          <>
            <MenuSeparator />
            <button
              type="button"
              disabled={isLoggingOut}
              onClick={() => {
                onClose();
                void logout();
              }}
              className="w-full px-4 min-h-[44px] flex items-center text-sm text-left text-slate-400 hover:text-white hover:bg-slate-700 disabled:opacity-50"
            >
              {isLoggingOut ? 'Logging out...' : 'Logout'}
            </button>
          </>
        )}
      </nav>
    </>
  );
}

function MenuSeparator() {
  return <div role="separator" className="my-1 h-px bg-slate-700" />;
}

interface NavMenuItemProps {
  to: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

function NavMenuItem({ to, active, onClick, children }: NavMenuItemProps) {
  return (
    <Link
      to={to}
      onClick={onClick}
      className={`block px-4 min-h-[44px] flex items-center text-sm no-underline ${
        active
          ? 'text-white bg-white/10'
          : 'text-slate-400 hover:text-white hover:bg-slate-700'
      }`}
    >
      {children}
    </Link>
  );
}
