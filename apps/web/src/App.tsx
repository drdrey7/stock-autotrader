import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./components";
import {
  ActivityPage,
  DashboardPage,
  DisclaimerPage,
  EarningsPage,
  LandingPage,
  MarketDataPage,
  MethodologyPage,
  NotFoundPage,
  PortfolioPage,
  ResearchDetailPage,
  ResearchPage,
  SignalsPage,
  StatusPage,
  StockPage,
  StrategiesPage,
  StrategyPage,
} from "./pages";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/methodology" element={<MethodologyPage />} />
      <Route path="/disclaimer" element={<DisclaimerPage />} />
      <Route path="/scanner" element={<Navigate to="/signals" replace />} />
      <Route element={<AppShell />}>
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/signals" element={<SignalsPage />} />
        <Route path="/stocks/:symbol" element={<StockPage />} />
        <Route path="/strategies" element={<StrategiesPage />} />
        <Route path="/strategies/:strategyId" element={<StrategyPage />} />
        <Route path="/research" element={<ResearchPage />} />
        <Route path="/research/:researchId" element={<ResearchDetailPage />} />
        <Route path="/portfolio" element={<PortfolioPage />} />
        <Route path="/earnings" element={<EarningsPage />} />
        <Route path="/market-data" element={<MarketDataPage />} />
        <Route path="/activity" element={<ActivityPage />} />
        <Route path="/status" element={<StatusPage />} />
      </Route>
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
