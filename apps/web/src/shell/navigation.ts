import {
  Activity,
  BrainCircuit,
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
  /** Also mark nested pages below one of `paths` active. */
  matchDescendants?: boolean;
  /**
   * Pathname(s) considered active for this item. `Dashboard` deliberately
   * includes `/` because the home route and `/dashboard` render the same
   * Morning Briefing page.
   */
  paths: string[];
  /** External AI Web destination when configured by the frontend environment. */
  external?: boolean;
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
      {
        label: "AI Analysis",
        to: typeof import.meta.env.VITE_AI_WEB_URL === "string" && /^https:\/\//u.test(import.meta.env.VITE_AI_WEB_URL)
          ? import.meta.env.VITE_AI_WEB_URL
          : "/ai-analysis",
        icon: BrainCircuit,
        paths: ["/ai-analysis"],
        matchDescendants: true,
        external: typeof import.meta.env.VITE_AI_WEB_URL === "string" && /^https:\/\//u.test(import.meta.env.VITE_AI_WEB_URL),
      },
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
  return item.paths.some((path) => pathname === path
    || (item.matchDescendants === true && pathname.startsWith(`${path}/`)));
}

export function findActiveNavItem(pathname: string): ShellNavItem | undefined {
  for (const group of shellNavGroups) {
    const active = group.items.find((item) => isNavItemActive(item, pathname));
    if (active) return active;
  }
  return undefined;
}
