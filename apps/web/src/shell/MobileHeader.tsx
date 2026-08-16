import { forwardRef } from "react";
import { Menu, X } from "lucide-react";
import { ThemeToggle } from "./theme";
import { ShellBrand } from "./SidebarNavigation";

interface MobileHeaderProps {
  menuOpen: boolean;
  onMenuToggle: () => void;
}

/**
 * Compact top app bar shown below the desktop breakpoint. The hamburger opens
 * the slide-in navigation drawer and exposes the correct expanded/control
 * semantics for assistive technology.
 */
export const MobileHeader = forwardRef<HTMLButtonElement, MobileHeaderProps>(
  function MobileHeader({ menuOpen, onMenuToggle }, menuButtonRef) {
    return (
      <header className="shell-topbar">
        <ShellBrand compact />
        <div className="shell-topbar-actions">
          <ThemeToggle />
          <button
            ref={menuButtonRef}
            type="button"
            className="shell-menu-button"
            onClick={onMenuToggle}
            aria-expanded={menuOpen}
            aria-controls="shell-mobile-nav"
            aria-label={menuOpen ? "Close main menu" : "Open main menu"}
          >
            {menuOpen ? <X size={20} aria-hidden="true" /> : <Menu size={20} aria-hidden="true" />}
          </button>
        </div>
      </header>
    );
  },
);
