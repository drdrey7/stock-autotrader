import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { User } from "lucide-react";
import { ThemeProvider, ThemeToggle } from "./theme";
import { SidebarNavigation, ShellBrand } from "./SidebarNavigation";
import { MobileHeader } from "./MobileHeader";
import { MobileNavigationDrawer } from "./MobileNavigationDrawer";
import { GlobalTicker } from "./GlobalTicker";
import "./shell.css";
import "./typography.css";

/**
 * Responsive dashboard shell wrapping every routed page.
 *
 * Desktop: a fixed left sidebar (brand, primary + secondary navigation) that
 * stays visible while the main content scrolls beside it.
 * Mobile: a compact top bar with the product identity and a hamburger that
 * opens a slide-in navigation drawer with a backdrop.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const wasOpenRef = useRef(false);

  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const toggleMenu = useCallback(() => setMenuOpen((open) => !open), []);

  // Prevent the page behind the drawer from scrolling while it is open.
  useEffect(() => {
    if (!menuOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [menuOpen]);

  // Escape closes the drawer.
  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeMenu();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [menuOpen, closeMenu]);

  // Close the drawer whenever navigation lands on a new route.
  const location = useLocation();
  useEffect(() => {
    closeMenu();
  }, [location.pathname, closeMenu]);

  // Crossing into the desktop breakpoint while the drawer is open hides it via
  // CSS but leaves `menuOpen` true — main content would stay inert and the Tab
  // trap armed with no on-screen close control. Close it as soon as the desktop
  // media query matches (Escape remains a manual fallback).
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const desktopQuery = window.matchMedia("(min-width: 901px)");
    if (typeof desktopQuery.addEventListener !== "function") return;
    const onDesktop = (event: MediaQueryListEvent) => {
      if (event.matches) closeMenu();
    };
    desktopQuery.addEventListener("change", onDesktop);
    return () => desktopQuery.removeEventListener("change", onDesktop);
  }, [closeMenu]);

  // Reasonable focus behaviour: focus the close control when opening, return
  // focus to the hamburger when the drawer closes after having been open.
  useEffect(() => {
    if (menuOpen) {
      wasOpenRef.current = true;
      closeButtonRef.current?.focus();
    } else if (wasOpenRef.current) {
      wasOpenRef.current = false;
      menuButtonRef.current?.focus();
    }
  }, [menuOpen]);

  return (
    <ThemeProvider>
      <div className="shell">
        <div className="shell-sidebar">
          <ShellBrand />
          <SidebarNavigation />
          <div className="shell-sidebar-footer">
            <button
              type="button"
              className="shell-account-button"
              aria-label="Account (coming soon)"
              title="Account (coming soon)"
              disabled
            >
              <User size={16} aria-hidden="true" />
            </button>
            <ThemeToggle />
          </div>
        </div>
        <MobileHeader ref={menuButtonRef} menuOpen={menuOpen} onMenuToggle={toggleMenu} />
        <MobileNavigationDrawer ref={closeButtonRef} open={menuOpen} onClose={closeMenu} />
        {/* The drawer is modal while open: background content is inert so it
            cannot receive focus or be reached by assistive technology. */}
        <main className="shell-main" inert={menuOpen}>
          {/* Global tape below the header, outside <Routes>: persists across
              every route change without remounting. */}
          <GlobalTicker />
          {children}
        </main>
      </div>
    </ThemeProvider>
  );
}
