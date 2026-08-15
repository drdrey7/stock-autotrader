import { Navigate, Route, Routes } from "react-router-dom";
import {
  DailyBriefingDisclaimerPage,
  DailyBriefingMethodologyPage,
  DailyBriefingNotFoundPage,
  DailyBriefingStatusPage,
} from "./daily-briefing-pages";
import MorningBriefingApp from "./morning-briefing/MorningBriefingApp";
import { AppShell } from "./shell/AppShell";

const legacyRoutes = [
  "/scanner",
  "/signals",
  "/stocks/:symbol",
  "/strategies",
  "/strategies/:strategyId",
  "/research",
  "/research/:researchId",
  "/portfolio",
  "/market-data",
  "/activity",
] as const;

export default function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<MorningBriefingApp />} />
        <Route path="/dashboard" element={<MorningBriefingApp />} />
        <Route path="/x" element={<MorningBriefingApp />} />
        <Route path="/x-search" element={<Navigate to="/x" replace />} />
        <Route path="/earnings" element={<MorningBriefingApp />} />
        <Route path="/methodology" element={<DailyBriefingMethodologyPage />} />
        <Route path="/status" element={<DailyBriefingStatusPage />} />
        <Route path="/disclaimer" element={<DailyBriefingDisclaimerPage />} />
        {legacyRoutes.map((path) => (
          <Route key={path} path={path} element={<Navigate to="/dashboard" replace />} />
        ))}
        <Route path="*" element={<DailyBriefingNotFoundPage />} />
      </Routes>
    </AppShell>
  );
}
