import { Navigate, Route, Routes } from "react-router-dom";
import {
  DailyBriefingDashboardPage,
  DailyBriefingLandingPage,
  DailyBriefingMethodologyPage,
  DailyBriefingNotFoundPage,
  DailyBriefingStatusPage,
  DailyBriefingDisclaimerPage,
} from "./daily-briefing-pages";
import { DailyBriefingXSearchPage } from "./x-search-page";

const legacyRoutes = [
  "/scanner",
  "/signals",
  "/stocks/:symbol",
  "/strategies",
  "/strategies/:strategyId",
  "/research",
  "/research/:researchId",
  "/portfolio",
  "/earnings",
  "/market-data",
  "/activity",
  "/x-search",
] as const;

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<DailyBriefingLandingPage />} />
      <Route path="/dashboard" element={<DailyBriefingDashboardPage />} />
      <Route path="/x" element={<DailyBriefingXSearchPage />} />
      <Route path="/methodology" element={<DailyBriefingMethodologyPage />} />
      <Route path="/status" element={<DailyBriefingStatusPage />} />
      <Route path="/disclaimer" element={<DailyBriefingDisclaimerPage />} />
      {legacyRoutes.map((path) => (
        <Route key={path} path={path} element={<Navigate to="/dashboard" replace />} />
      ))}
      <Route path="*" element={<DailyBriefingNotFoundPage />} />
    </Routes>
  );
}
