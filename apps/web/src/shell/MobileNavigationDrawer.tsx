import { forwardRef, useEffect, useRef } from "react";
import { X } from "lucide-react";
import { SidebarNavigation, ShellBrand } from "./SidebarNavigation";

interface MobileNavigationDrawerProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Slide-in navigation drawer used below the desktop breakpoint. Rendered above
 * the page content with a backdrop; closes on link activation, backdrop click,
 * the explicit close button or Escape (handled by the parent shell).
 *
 * While open it keeps focus inside the drawer (Tab cycle) so the page behind
 * stays unreachable; while closed it is inert and hidden from the accessibility
 * tree so nothing is focusable behind the scenes.
 */
export const MobileNavigationDrawer = forwardRef<HTMLButtonElement, MobileNavigationDrawerProps>(
  function MobileNavigationDrawer({ open, onClose }, closeButtonRef) {
    const drawerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
      if (!open) return;
      const drawer = drawerRef.current;
      if (!drawer) return;
      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key !== "Tab") return;
        const focusable = drawer.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (focusable.length === 0) return;
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      };
      document.addEventListener("keydown", handleKeyDown);
      return () => document.removeEventListener("keydown", handleKeyDown);
    }, [open]);

    return (
      <div
        className={`shell-drawer-backdrop${open ? " is-open" : ""}`}
        aria-hidden={!open}
        inert={!open}
        onClick={onClose}
      >
        <div
          ref={drawerRef}
          id="shell-mobile-nav"
          className="shell-drawer"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="shell-drawer-head">
            <ShellBrand compact />
            <button
              ref={closeButtonRef}
              type="button"
              className="shell-drawer-close"
              onClick={onClose}
              aria-label="Close menu"
            >
              <X size={20} aria-hidden="true" />
            </button>
          </div>
          <SidebarNavigation onNavigate={onClose} />
        </div>
      </div>
    );
  },
);
