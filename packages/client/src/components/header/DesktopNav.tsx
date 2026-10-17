import { PlusIcon } from '../Icons';
import { NotificationBell } from '../notifications';
import { useAuth } from '../../lib/auth';
import { TopNavLink, ValidationWarningIndicator } from './NavLinks';
import { navItemsByPlacement } from './nav-items';
import { UserMenu } from './UserMenu';

interface DesktopNavProps {
  onCreateWorktree: () => void;
  isMobile: boolean;
}

/** The desktop header's navigation contents; the caller owns the surrounding <nav>. */
export function DesktopNav({ onCreateWorktree, isMobile }: DesktopNavProps) {
  const { isMultiUser } = useAuth();

  return (
    <>
      <button
        type="button"
        onClick={onCreateWorktree}
        className="text-slate-400 hover:text-white p-1 rounded hover:bg-white/10 transition-colors"
        title="Create worktree"
      >
        <PlusIcon className="w-4 h-4" />
      </button>
      <ValidationWarningIndicator />
      {navItemsByPlacement('top', isMultiUser).map((item) => (
        <TopNavLink key={item.id} item={item} />
      ))}
      {/* isMobile-gated: the parent <nav> is only CSS-hidden (hidden md:flex) on mobile, not
          unmounted, so without this gate NotificationBell would double-mount alongside
          MobileHeaderControls' own instance. */}
      {!isMobile && <NotificationBell />}
      <UserMenu />
    </>
  );
}
