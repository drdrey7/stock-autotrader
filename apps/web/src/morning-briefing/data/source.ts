export type DataSource = "live" | "mock" | "mixed";

export const sourceLabel = (source: DataSource) =>
  source === "live" ? "Live" : source === "mixed" ? "Live + demo" : "Demo";
