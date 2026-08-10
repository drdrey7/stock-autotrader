import { useEffect, useState, type ReactNode } from "react";
import type { DashboardData } from "@stock-autotrader/contracts";
import { demoData, getDashboardData } from "./api";
import { DataContext } from "./data-context";

export function DataProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<DashboardData>(demoData);

  useEffect(() => {
    const controller = new AbortController();
    getDashboardData(controller.signal).then(setData).catch(() => setData(demoData));
    return () => controller.abort();
  }, []);

  return <DataContext.Provider value={data}>{children}</DataContext.Provider>;
}

