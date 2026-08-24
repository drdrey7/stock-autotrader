import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { DailyBriefingNotFoundPage, DailyBriefingStatusPage } from "./information/InformationPages";
import MorningBriefingApp from "./morning-briefing/MorningBriefingApp";
import { LazyPageErrorBoundary, PageLoadingFallback } from "./morning-briefing/shared";
import { AppShell } from "./shell/AppShell";

const StockDetailPage = lazy(() => import("./morning-briefing/stock-detail/StockDetailPage"));
const InvestorHubPage = lazy(() => import("./account/InvestorHubPage"));
const AiAnalysisPage = lazy(() => import("./ai-analysis/AiAnalysisPage"));

const legacyRoutes = [
  "/signals",
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
        <Route path="/heatmap" element={<MorningBriefingApp />} />
        <Route path="/x" element={<MorningBriefingApp />} />
        <Route path="/x-search" element={<Navigate to="/x" replace />} />
        <Route path="/earnings" element={<MorningBriefingApp />} />
        <Route path="/screener" element={<MorningBriefingApp />} />
        <Route
          path="/stocks/:symbol"
          element={(
            <LazyPageErrorBoundary resetKey="stock-detail">
              <Suspense fallback={<PageLoadingFallback />}>
                <StockDetailPage />
              </Suspense>
            </LazyPageErrorBoundary>
          )}
        />
        <Route
          path="/account"
          element={(
            <LazyPageErrorBoundary resetKey="investor-hub">
              <Suspense fallback={<PageLoadingFallback />}>
                <InvestorHubPage />
              </Suspense>
            </LazyPageErrorBoundary>
          )}
        />
        <Route
          path="/ai-analysis"
          element={(
            <LazyPageErrorBoundary resetKey="ai-analysis">
              <Suspense fallback={<PageLoadingFallback />}>
                <AiAnalysisPage />
              </Suspense>
            </LazyPageErrorBoundary>
          )}
        />
        <Route
          path="/ai-analysis/runs/:runId"
          element={(
            <LazyPageErrorBoundary resetKey="ai-analysis-run">
              <Suspense fallback={<PageLoadingFallback />}>
                <AiAnalysisPage />
              </Suspense>
            </LazyPageErrorBoundary>
          )}
        />
        {/* /scanner was the older name for the screener: keep the intent. */}
        <Route path="/scanner" element={<Navigate to="/screener" replace />} />
        <Route path="/status" element={<DailyBriefingStatusPage />} />
        {legacyRoutes.map((path) => (
          <Route key={path} path={path} element={<Navigate to="/dashboard" replace />} />
        ))}
        <Route path="*" element={<DailyBriefingNotFoundPage />} />
      </Routes>
    </AppShell>
  );
}
