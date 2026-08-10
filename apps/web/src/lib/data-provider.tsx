import { useEffect, useState, type ReactNode } from "react";
import type { DashboardData } from "@stock-autotrader/contracts";
import { demoData, getDashboardData } from "./api";
import { DataContext } from "./data-context";

export const POLL_INTERVAL_MS = 60_000;

export function DataProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<DashboardData>(demoData);

  useEffect(() => {
    let controller: AbortController | undefined;
    let disposed = false;
    const refresh = () => {
      controller?.abort();
      controller = new AbortController();
      getDashboardData(controller.signal)
        .then((next) => {
          if (!disposed) setData(next);
        })
        .catch((error: unknown) => {
          if (
            !disposed &&
            !(error instanceof DOMException && error.name === "AbortError")
          ) {
            // Keep the last validated snapshot. Initial state remains clearly labelled demo data.
          }
        });
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    refresh();
    const timer = window.setInterval(refreshWhenVisible, POLL_INTERVAL_MS);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      disposed = true;
      controller?.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, []);

  return <DataContext.Provider value={data}>{children}</DataContext.Provider>;
}
