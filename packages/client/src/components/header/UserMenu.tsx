import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Link, useLocation } from '@tanstack/react-router';
import { useAuth } from '../../lib/auth';
import { useLogout } from '../../hooks/useLogout';
import { ChevronDownIcon, UserCircleIcon } from '../Icons';
import { isNavItemActive, navItemsByPlacement } from './nav-items';

const ITEM_CLASS =
  'block px-3 py-2 text-sm no-underline outline-none cursor-pointer data-[highlighted]:bg-slate-700 data-[highlighted]:text-white';

/** The header's account menu: the 'menu' group of NAV_ITEMS plus Logout in multi-user mode. */
export function UserMenu() {
  const location = useLocation();
  const { isMultiUser, currentUser } = useAuth();
  const { logout, isLoggingOut } = useLogout();

  const items = navItemsByPlacement('menu', isMultiUser);
  const anyActive = items.some((item) => isNavItemActive(item, location.pathname));
  const username = isMultiUser ? currentUser?.username : undefined;

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          // Single-user mode shows only an icon, so it needs a label; multi-user is named by the visible username.
          aria-label={username ? undefined : 'Account menu'}
          className={`text-sm py-1 px-2 rounded flex items-center gap-1.5 ${
            anyActive ? 'text-white bg-white/10' : 'text-slate-400'
          }`}
        >
          <UserCircleIcon className="w-4 h-4" />
          {username && <span>{username}</span>}
          {username && <ChevronDownIcon className="w-3 h-3" />}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className="z-40 min-w-48 bg-slate-800 border border-slate-700 rounded-lg shadow-lg py-1 text-sm"
        >
          {username && (
            <>
              <DropdownMenu.Label className="px-3 py-2 text-xs text-slate-500">
                {username}
              </DropdownMenu.Label>
              <DropdownMenu.Separator className="my-1 h-px bg-slate-700" />
            </>
          )}
          {items.map((item) => (
            <DropdownMenu.Item key={item.id} asChild>
              <Link
                to={item.to}
                className={`${ITEM_CLASS} ${
                  isNavItemActive(item, location.pathname) ? 'text-white bg-white/10' : 'text-slate-400'
                }`}
              >
                {item.label}
              </Link>
            </DropdownMenu.Item>
          ))}
          {isMultiUser && (
            <>
              <DropdownMenu.Separator className="my-1 h-px bg-slate-700" />
              <DropdownMenu.Item
                disabled={isLoggingOut}
                onSelect={(event) => {
                  // Keep the menu open so the "Logging out..." state stays visible until navigation.
                  event.preventDefault();
                  void logout();
                }}
                className={`${ITEM_CLASS} text-slate-400 data-[disabled]:opacity-50`}
              >
                {isLoggingOut ? 'Logging out...' : 'Logout'}
              </DropdownMenu.Item>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
