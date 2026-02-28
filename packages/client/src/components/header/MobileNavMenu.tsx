import { useEffect, useCallback } from 'react';
import { Link, useLocation } from '@tanstack/react-router';

interface MobileNavMenuProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Mobile navigation dropdown menu.
 * Shows main navigation links (Jobs, Agents, Repositories) in a dropdown.
 */
export function MobileNavMenu({ open, onClose }: MobileNavMenuProps) {
  const location = useLocation();

  // Close on Escape key
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    },
    [onClose]
  );

  useEffect(() => {
    if (!open) return;
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, handleKeyDown]);

  if (!open) return null;

  const isActive = (path: string) => location.pathname.startsWith(path);
  const isExact = (path: string) => location.pathname === path;

  return (
    <>
      {/* Invisible backdrop to close menu on outside click */}
      <div className="fixed inset-0 z-30" aria-hidden="true" onClick={onClose} />
      {/* Dropdown menu */}
      <nav
        aria-label="Main navigation"
        className="absolute right-2 top-full z-40 mt-1 w-48 bg-slate-800 border border-slate-700 rounded-lg shadow-lg py-1"
      >
        <NavMenuItem
          to="/jobs"
          active={isActive('/jobs')}
          onClick={onClose}
        >
          Jobs
        </NavMenuItem>
        <NavMenuItem
          to="/agents"
          active={isActive('/agents')}
          onClick={onClose}
        >
          Agents
        </NavMenuItem>
        <NavMenuItem
          to="/settings/repositories"
          active={isExact('/settings/repositories')}
          onClick={onClose}
        >
          Repositories
        </NavMenuItem>
      </nav>
    </>
  );
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
