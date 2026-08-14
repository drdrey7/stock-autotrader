import { demoData } from "@stock-autotrader/contracts/src/demo-data";
import { dashboardReadSchema, type DashboardData } from "@stock-autotrader/contracts";

// The read contract lives in @stock-autotrader/contracts so the Worker (which
// validates its own constructed read model before serving) and this client
// (which validates the fetched response before trusting it) share one
// schema instead of two independently hand-maintained copies.
export const dashboardPayload = dashboardReadSchema;

const apiBase = (
  import.meta.env.VITE_API_BASE_URL as string | undefined
)?.replace(/\/$/, "");
const explicitDemo = import.meta.env.VITE_DEMO_MODE !== "false";

export async function getDashboardData(
  signal?: AbortSignal,
): Promise<DashboardData> {
  if (explicitDemo) return demoData;
  // Same-origin by default (worker serves both the SPA and /api/*); override with VITE_API_BASE_URL.
  const url = apiBase ? `${apiBase}/api/dashboard` : "/api/dashboard";
  const response = await fetch(url, {
    signal,
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Public API returned ${response.status}`);
  // Same schema-to-type gap the Worker's own buildDashboard() carries (e.g.
  // momentum is optional/nullable at the wire level but required on
  // Candidate) — matches its established `as DashboardData` cast exactly.
  return dashboardPayload.parse(await response.json()) as DashboardData;
}

export { demoData };
