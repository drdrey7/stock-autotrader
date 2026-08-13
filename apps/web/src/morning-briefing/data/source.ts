export type DataSource = "live" | "mock" | "mixed" | "cached";

export const sourceLabel = (source: DataSource) =>
  source === "live" ? "Live" : source === "mixed" ? "Live + demo" : source === "cached" ? "Last update" : "Demo";
