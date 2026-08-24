import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Check, Circle, LoaderCircle } from "lucide-react";
import {
  aiAnalysisWorkflowStages,
  type AiAnalysisRunStatus,
} from "@stock-autotrader/contracts";

interface AnalysisJourneyProps {
  status: AiAnalysisRunStatus;
  symbol: string;
  onComplete: () => void;
}

const STAGE_DURATION_MS = 1_150;
const FINAL_PAUSE_MS = 650;

function journeyMessage(status: AiAnalysisRunStatus, label: string): string {
  if (status === "queued") return `Preparing ${label.toLocaleLowerCase()}`;
  if (status === "completed") return `Reviewing ${label.toLocaleLowerCase()}`;
  return label;
}

/**
 * Individual presentation of the pinned TradingAgents workflow. The sequence
 * may finish before the real analysis does, but the final report never appears
 * until the backend has returned a completed, schema-validated result.
 */
export function AnalysisJourney({ status, symbol, onComplete }: AnalysisJourneyProps) {
  const reducedMotion = useReducedMotion();
  const [activeIndex, setActiveIndex] = useState(0);
  const completionSentRef = useRef(false);
  const finalIndex = aiAnalysisWorkflowStages.length - 1;

  useEffect(() => {
    completionSentRef.current = false;
    setActiveIndex(0);
  }, [symbol]);

  useEffect(() => {
    if (status === "failed") return;
    if (reducedMotion) {
      if (status === "completed" && !completionSentRef.current) {
        completionSentRef.current = true;
        onComplete();
      }
      return;
    }

    if (activeIndex < finalIndex) {
      const timer = window.setTimeout(() => setActiveIndex((index) => Math.min(index + 1, finalIndex)), STAGE_DURATION_MS);
      return () => window.clearTimeout(timer);
    }
    if (status === "completed" && !completionSentRef.current) {
      const timer = window.setTimeout(() => {
        completionSentRef.current = true;
        onComplete();
      }, FINAL_PAUSE_MS);
      return () => window.clearTimeout(timer);
    }
  }, [activeIndex, finalIndex, onComplete, reducedMotion, status]);

  const activeStage = aiAnalysisWorkflowStages[activeIndex];

  return (
    <section className="ai-journey-card" aria-labelledby="ai-journey-title" aria-busy={status !== "completed"}>
      <header className="ai-journey-header">
        <div>
          <span className="ai-kicker">Multi-agent research</span>
          <h1 id="ai-journey-title">Analyzing {symbol}</h1>
          <p>The research team is working through market evidence, competing views and risk.</p>
        </div>
        <span className="ai-journey-orbit" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
      </header>

      <p className="ai-stage-announcement" role="status" aria-live="polite">
        {activeStage ? journeyMessage(status, activeStage.label) : "Preparing your analysis"}
      </p>

      <ol className="ai-stage-list">
        {aiAnalysisWorkflowStages.map((stage, index) => {
          const stageState = index < activeIndex ? "complete" : index === activeIndex ? "active" : "pending";
          return (
            <motion.li
              key={stage.key}
              className={`ai-stage is-${stageState}`}
              aria-current={stageState === "active" ? "step" : undefined}
              initial={reducedMotion ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: reducedMotion ? 0 : index * 0.035, duration: 0.2 }}
            >
              <span className="ai-stage-state" aria-hidden="true">
                {stageState === "complete" ? <Check size={15} /> : stageState === "active" ? <LoaderCircle size={16} /> : <Circle size={13} />}
              </span>
              <span className="ai-stage-copy">
                <strong>{stage.label}</strong>
                <small>{stage.agents.join(" · ")}</small>
              </span>
              <span className="ai-visually-hidden">
                {stageState === "complete" ? "Complete" : stageState === "active" ? "In progress" : "Pending"}
              </span>
            </motion.li>
          );
        })}
      </ol>

      <AnimatePresence mode="wait">
        <motion.p
          key={`${status}-${activeStage?.key ?? "start"}`}
          className="ai-journey-note"
          initial={reducedMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={reducedMotion ? undefined : { opacity: 0 }}
        >
          {status === "completed" && activeIndex === finalIndex
            ? "The analysis is complete. Preparing your report…"
            : "Your report will appear only after the analysis is complete."}
        </motion.p>
      </AnimatePresence>
    </section>
  );
}

