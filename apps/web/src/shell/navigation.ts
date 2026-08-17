import { Activity, CalendarClock, Globe2, LayoutDashboard, LayoutGrid, type LucideIcon } from "lucide-react";

/**
 * Single source of truth for the application shell navigation.
 *
 * Both the desktop sidebar and the mobile drawer render from this list so the
 * route set cannot drift between the two. The route paths below are the real
 * routes registered in `App.tsx` — nothing here may point at a route that does
 * not exist in the product.
 */
export interface ShellNavItem {
  /** Visible label for the navigation link. */
  label: string;
  /** Target route. */
  to: string;
  icon: LucideIcon;
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
      { label: "Heatmap", to: "/heatmap", icon: LayoutGrid, paths: ["/heatmap"] },
      { label: "X Pulse", to: "/x", icon: Globe2, paths: ["/x"] },
      { label: "Earnings", to: "/earnings", icon: CalendarClock, paths: ["/earnings"] },
    ],
  },
  {
    label: "Information",
    items: [{ label: "Status", to: "/status", icon: Activity, paths: ["/status"] }],
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
