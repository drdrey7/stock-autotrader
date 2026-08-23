import {
  Activity,
  CalendarClock,
  CircleUserRound,
  Flame,
  LayoutDashboard,
  ListFilter,
  type LucideIcon,
} from "lucide-react";

/**
 * Single source of truth for the application shell navigation.
 *
 * Both the desktop sidebar and the mobile drawer render from this list so the
 * route set cannot drift between them. The route paths below are the public
 * destinations intentionally exposed in the shell. Internal/direct routes may
 * exist without being listed here.
 */
export interface ShellNavItem {
  /** Visible label for the navigation link. */
  label: string;
  /** Target route. */
  to: string;
  icon: LucideIcon;
  /** Render the full navigation row only in the mobile drawer. */
  mobileOnly?: boolean;
  /**
   * Pathname(s) considered active for this item. `Dashboard` deliberately
   * includes `/` because the home route and `/dashboard` render the same
   * Morning Briefing page.
   */
  paths: string[];
}

export interface ShellNavGroup {
  label: string;
  items: ShellNavItem[];
}

export const shellNavGroups: ShellNavGroup[] = [
  {
    label: "Product",
    items: [
      { label: "Dashboard", to: "/dashboard", icon: LayoutDashboard, paths: ["/", "/dashboard"] },
      { label: "Heatmap", to: "/heatmap", icon: Flame, paths: ["/heatmap"] },
      { label: "Screener", to: "/screener", icon: ListFilter, paths: ["/screener"] },
      { label: "Earnings", to: "/earnings", icon: CalendarClock, paths: ["/earnings"] },
    ],
  },
  {
    label: "Information",
    items: [
      { label: "Investor Hub", to: "/account", icon: CircleUserRound, mobileOnly: true, paths: ["/account"] },
      { label: "Status", to: "/status", icon: Activity, paths: ["/status"] },
    ],
  },
];

export function isNavItemActive(item: ShellNavItem, pathname: string): boolean {
  return item.paths.includes(pathname);
}

export function findActiveNavItem(pathname: string): ShellNavItem | undefined {
  for (const group of shellNavGroups) {
    const active = group.items.find((item) => isNavItemActive(item, pathname));
    if (active) return active;
  }
  return undefined;
}
