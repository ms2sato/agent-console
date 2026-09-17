import { useRef } from 'react';
import { useModalDrawerFocus } from '../../hooks/useModalDrawerFocus';

interface MobileSidebarDrawerProps {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}

/**
 * Mobile overlay drawer for the sessions sidebar.
 * Always rendered (for CSS transitions); visibility controlled via translate.
 */
export function MobileSidebarDrawer({ open, onClose, children }: MobileSidebarDrawerProps) {
  const drawerRef = useRef<HTMLDivElement>(null);
  const { containerProps } = useModalDrawerFocus({ open, onClose, containerRef: drawerRef });

  return (
    <>
      <div
        className={`fixed inset-0 z-40 bg-black/50 transition-opacity duration-300 ${
          open ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
        aria-hidden="true"
        onClick={onClose}
      />
      <div
        ref={drawerRef}
        role="dialog"
        aria-label="Sessions drawer"
        className={`fixed top-0 left-0 z-50 h-full w-72 flex flex-col overflow-hidden bg-slate-900 transition-transform duration-300 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
        {...containerProps}
      >
        {children}
      </div>
    </>
  );
}
