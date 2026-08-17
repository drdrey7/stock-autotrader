import { lazy, Suspense, useEffect, useState } from "react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { useLocation } from "react-router-dom";
import type { EarningsCompany } from "./data/earnings-view";
import MorningBriefingPage from "./MorningBriefingPage";
import { LazyPageErrorBoundary, PageLoadingFallback, spring } from "./shared";

const HeatmapPage = lazy(() => import("./HeatmapPage"));
const XPulsePage = lazy(() => import("./XPulsePage"));
const EarningsPage = lazy(() => import("./EarningsCalendarPage"));
const EarningsDetail = lazy(() => import("./EarningsDetail"));

type Page = "briefing" | "heatmap" | "surge" | "earnings";

function MorningBriefingShell() {
  const location = useLocation();
  const page: Page = location.pathname === "/heatmap"
    ? "heatmap"
    : location.pathname === "/x"
      ? "surge"
      : location.pathname === "/earnings"
        ? "earnings"
        : "briefing";
  const [selectedEarnings, setSelectedEarnings] = useState<EarningsCompany | null>(null);

  useEffect(() => {
    const reduced = typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
  }, [page]);

  useEffect(() => {
    setSelectedEarnings(null);
  }, [page]);

  return (
    <div className="mb-demo">
      <AnimatePresence mode="wait">
        <motion.div
          key={page}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={spring}
        >
          <LazyPageErrorBoundary resetKey={page}>
            <Suspense fallback={<PageLoadingFallback/>}>
              {page === "briefing" && <MorningBriefingPage/>}
              {page === "heatmap" && <HeatmapPage/>}
              {page === "surge" && <XPulsePage/>}
              {page === "earnings" && <EarningsPage onSelect={setSelectedEarnings}/>}
            </Suspense>
          </LazyPageErrorBoundary>
        </motion.div>
      </AnimatePresence>

      <footer>
        <span>Morning Briefing</span>
        <p>Public, read-only market intelligence.</p>
      </footer>

      <AnimatePresence>
        {selectedEarnings && (
          <LazyPageErrorBoundary resetKey={`earnings-detail-${selectedEarnings.id}`}>
            <Suspense fallback={null}>
              <EarningsDetail item={selectedEarnings} onClose={() => setSelectedEarnings(null)}/>
            </Suspense>
          </LazyPageErrorBoundary>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function MorningBriefingApp() {
  return (
    <MotionConfig reducedMotion="user">
      <MorningBriefingShell/>
    </MotionConfig>
  );
}
