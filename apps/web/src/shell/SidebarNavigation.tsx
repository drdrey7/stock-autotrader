import { BarChart3 } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { isNavItemActive, shellNavGroups } from "./navigation";

/** Product identity used by the desktop sidebar and the mobile drawer/top bar. */
export function ShellBrand({ compact = false }: { compact?: boolean }) {
  return (
    <Link className="shell-brand" to="/dashboard" aria-label="Morning Briefing home">
      <span className="shell-brand-mark" aria-hidden="true">
        <BarChart3 size={18} />
      </span>
      <span className="shell-brand-copy">
        <strong>Morning Briefing</strong>
        {!compact && <small>Markets • Opportunities • Insights</small>}
      </span>
    </Link>
  );
}

interface SidebarNavigationProps {
  /** Called when a link is activated (used by the mobile drawer to close itself). */
  onNavigate?: () => void;
}

/**
 * Navigation links shared by the desktop sidebar and the mobile drawer. Both
 * render from `shellNavGroups` so the route list cannot drift between them.
 */
export function SidebarNavigation({ onNavigate }: SidebarNavigationProps) {
  const { pathname } = useLocation();
  return (
    <nav className="shell-nav" aria-label="Primary navigation">
      {shellNavGroups.map((group, groupIndex) => (
        <div
          key={group.label}
          className={`shell-nav-group${groupIndex > 0 ? " shell-nav-group-secondary" : ""}`}
        >
          {group.items.map((item) => {
            const active = isNavItemActive(item, pathname);
            const Icon = item.icon;
            return (
              <Link
                key={item.to}
                className={`shell-nav-link${active ? " is-active" : ""}`}
                to={item.to}
                aria-current={active ? "page" : undefined}
                onClick={onNavigate}
              >
                <Icon size={17} aria-hidden="true" />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
