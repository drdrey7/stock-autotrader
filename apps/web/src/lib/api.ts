import { demoData } from "@stock-autotrader/contracts/src/demo-data";
import type { DashboardData } from "@stock-autotrader/contracts";

const apiBase = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "");
const explicitDemo = import.meta.env.VITE_DEMO_MODE !== "false";

export async function getDashboardData(signal?: AbortSignal): Promise<DashboardData> {
  if (!apiBase || explicitDemo) return demoData;
  const response = await fetch(`${apiBase}/api/dashboard`, { signal, headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Public API returned ${response.status}`);
  return (await response.json()) as DashboardData;
}

export { demoData };

