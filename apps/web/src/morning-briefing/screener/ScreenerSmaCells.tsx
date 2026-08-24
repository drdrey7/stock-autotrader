import type { ReactNode } from "react";
import type { ScreenerRow } from "@stock-autotrader/contracts";

const INSUFFICIENT_HISTORY_TITLE = "Insufficient history for a 200-week SMA";

function unavailableCell(row: ScreenerRow): ReactNode {
  const notEnoughHistory = row.sma200wState === "NotEnoughHistory";
  return (
    <span className="scr-flat" title={notEnoughHistory ? INSUFFICIENT_HISTORY_TITLE : undefined}>
      {notEnoughHistory ? "N/A" : "—"}
    </span>
  );
}

export function distanceCell(row: ScreenerRow): ReactNode {
  const distance = row.distanceToSma200wPct ?? null;
  if (distance === null) return unavailableCell(row);

  const state = row.sma200wState ?? "Unavailable";
  const className = state === "Above" ? "scr-up" : state === "Below" ? "scr-down" : "scr-near";
  const sign = distance > 0 ? "+" : "";
  return <span className={className} title={state}>{sign}{distance.toFixed(1)}%</span>;
}

export function smaCell(row: ScreenerRow): ReactNode {
  const sma = row.sma200w ?? null;
  if (sma === null) return unavailableCell(row);
  return <span className="scr-price">{sma.toFixed(2)}</span>;
}
