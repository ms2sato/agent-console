import { MenuIcon, LayoutListIcon } from '../Icons';
import { MobileNavMenu } from './MobileNavMenu';
import { MobileSidebarDrawer } from '../sidebar/MobileSidebarDrawer';

export interface MobileHeaderControlsProps {
  mobileNavOpen: boolean;
  mobileSidebarOpen: boolean;
  hasAnyAsking: boolean;
  onOpenSidebar: () => void;
  onCloseSidebar: () => void;
  onToggleNav: () => void;
  onCloseNav: () => void;
  sidebarContent: React.ReactNode;
}

export function MobileHeaderControls({
  mobileNavOpen,
  mobileSidebarOpen,
  hasAnyAsking,
  onOpenSidebar,
  onCloseSidebar,
  onToggleNav,
  onCloseNav,
  sidebarContent,
}: MobileHeaderControlsProps) {
  return (
    <>
      <div className="ml-auto flex items-center gap-1 md:hidden">
        <button
          onClick={onOpenSidebar}
          className="relative p-2 text-gray-400 hover:text-white min-w-[44px] min-h-[44px] flex items-center justify-center"
          aria-label="Open sessions"
        >
          <LayoutListIcon className="w-5 h-5" />
          {hasAnyAsking && (
            <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-yellow-400 rounded-full" aria-hidden="true" />
          )}
        </button>
        <button
          onClick={onToggleNav}
          className="p-2 text-gray-400 hover:text-white min-w-[44px] min-h-[44px] flex items-center justify-center"
          aria-label={mobileNavOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={mobileNavOpen}
        >
          <MenuIcon className="w-5 h-5" />
        </button>
      </div>

      <MobileNavMenu open={mobileNavOpen} onClose={onCloseNav} />

      <MobileSidebarDrawer open={mobileSidebarOpen} onClose={onCloseSidebar}>
        {sidebarContent}
      </MobileSidebarDrawer>
    </>
  );
}
