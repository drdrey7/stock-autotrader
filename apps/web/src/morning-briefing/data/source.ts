import type { SourceHealth } from "@stock-autotrader/contracts";

export type DataSource = "live" | "cached" | "stale" | "unavailable" | "error";

export { type SourceHealth };

export const sourceLabel = (source: DataSource) =>
  source === "live" ? "Live" : source === "cached" ? "Cached" : source === "stale" ? "Stale" : source === "error" ? "Error" : "Unavailable";

export const stateFromHealth = (health: SourceHealth | undefined): DataSource => {
  if (!health) return "unavailable";
  return health.state.toLowerCase() as DataSource;
};
