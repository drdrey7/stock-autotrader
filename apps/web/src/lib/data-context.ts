import { createContext, useContext } from "react";
import type { DashboardData } from "@stock-autotrader/contracts";
import { demoData } from "./api";

export const DataContext = createContext<DashboardData>(demoData);

export function useData(): DashboardData {
  return useContext(DataContext);
}

