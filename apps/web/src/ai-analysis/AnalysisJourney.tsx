import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Check, Circle, LoaderCircle } from "lucide-react";
import {
  aiAnalysisWorkflowStages,
  type AiAnalysisRunStatus,
  type AiAnalysisProgressStage,
} from "@stock-autotrader/contracts";

interface AnalysisJourneyProps {
  status: AiAnalysisRunStatus;
  symbol: string;
  progressStage: AiAnalysisProgressStage | null;
  progressStep: number;
  progressTotal: number;
}

function journeyMessage(status: AiAnalysisRunStatus, label: string): string {
  if (status === "queued") return `Preparing ${label.toLocaleLowerCase()}`;
  if (status === "completed") return `Reviewing ${label.toLocaleLowerCase()}`;
  return label;
}

/**
 * Presentation of real pinned TradingAgents node transitions. The server is
 * authoritative; this component never advances progress on a timer.
 */
export function AnalysisJourney({ status, symbol, progressStage, progressStep, progressTotal }: AnalysisJourneyProps) {
  const reducedMotion = useReducedMotion();
  const activeIndex = progressStage === null
    ? Math.max(0, Math.min(progressStep - 1, aiAnalysisWorkflowStages.length - 1))
    : Math.max(0, aiAnalysisWorkflowStages.findIndex((stage) => stage.key === progressStage));
  const activeStage = progressStep > 0 ? aiAnalysisWorkflowStages[activeIndex] : null;

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
          const stageState = progressStep > index + 1 ? "complete" : index === activeIndex && progressStep > 0 ? "active" : "pending";
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
          {status === "queued" && progressStep === 0
            ? "Your analysis is queued and will continue in the background."
            : `Stage ${Math.min(progressStep, progressTotal)} of ${progressTotal}. Your report will appear when complete.`}
        </motion.p>
      </AnimatePresence>
    </section>
  );
}
