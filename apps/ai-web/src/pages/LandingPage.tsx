import { CSSProperties, FormEvent, useEffect, useState } from "react";
import {
  ArrowUpRight,
  FileText,
  Search,
} from "lucide-react";
import { motion } from "motion/react";
import { Link } from "react-router-dom";
import { Shell } from "../components/layout/Shell";
import { ResearchCoverage } from "../components/research/ResearchCoverage";
import { SponsorRail } from "../components/sponsors/SponsorRail";
import { Atmosphere } from "../components/visual/Atmosphere";

const agents = [
  ["01", "Market Analyst", "Price, volume and technical structure."],
  ["02", "Sentiment Analyst", "Yahoo, StockTwits and Reddit narrative."],
  ["03", "News Analyst", "Company news, FRED macro and event odds."],
  ["04", "Fundamentals Analyst", "Income, balance sheet and cash flow."],
  ["05", "Bull Researcher", "Strongest evidence-backed upside case."],
  ["06", "Bear Researcher", "Assumption stress-test and downside."],
  ["07", "Research Manager", "Judges the debate and sets the plan."],
  ["08", "Trader", "Turns research into a concrete proposal."],
  ["09", "Aggressive Risk", "Higher-conviction risk lens."],
  ["10", "Neutral Risk", "Balanced risk lens."],
  ["11", "Conservative Risk", "Capital-preservation risk lens."],
  ["12", "Portfolio Manager", "Final rating, thesis and optional target."],
] as const;

export function LandingPage() {
  const [symbol, setSymbol] = useState("");
  const [message, setMessage] = useState("");
  const [demoSymbol, setDemoSymbol] = useState("NVDA");
  const [demoStage, setDemoStage] = useState(-1);
  const demoIsRunning = demoStage >= 0 && demoStage < agents.length;

  useEffect(() => {
    if (!demoIsRunning) return;

    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const timer = window.setTimeout(
      () => setDemoStage((stage) => Math.min(stage + 1, agents.length)),
      reduceMotion ? 260 : 1050,
    );

    return () => window.clearTimeout(timer);
  }, [demoIsRunning, demoStage]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const ticker = symbol.trim() || "NVDA";
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    setSymbol(ticker);
    setDemoSymbol(ticker);
    setDemoStage(0);
    setMessage(
      `Illustrative ${ticker} demo — no backend request has been sent.`,
    );
    window.setTimeout(
      () =>
        document.getElementById("agents")?.scrollIntoView({
          behavior: reduceMotion ? "auto" : "smooth",
          block: "center",
        }),
      80,
    );
  };
  const credits = () =>
    setMessage("Credit checkout will connect to Stripe soon.");
  return (
    <Shell>
      <SponsorRail />
      <main className="editorial-page">
        <section className="editorial-hero">
          <Atmosphere />
          <div className="editorial-hero-copy">
            <motion.div
              className="editorial-kicker"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
            >
              Powered by Multi-Agent AI Research
            </motion.div>
            <motion.h1
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0, transition: { delay: 0.1 } }}
            >
              AI research.
              <br />
              <em>Sharper decisions.</em>
            </motion.h1>
            <motion.p
              className="editorial-lede"
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0, transition: { delay: 0.18 } }}
            >
              Twelve specialised agents investigate one company from different
              angles, debate the thesis and deliver one clear research brief.
            </motion.p>
            <motion.form
              className="editorial-search"
              onSubmit={submit}
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0, transition: { delay: 0.26 } }}
            >
              <div>
                <Search size={17} />
                <input
                  value={symbol}
                  onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                  placeholder="Enter stock ticker or company"
                  aria-label="Stock ticker"
                  maxLength={8}
                />
              </div>
              <button type="submit" disabled={demoIsRunning}>
                {demoIsRunning ? "Researching…" : "Run analysis demo"}{" "}
                <ArrowUpRight size={16} />
              </button>
            </motion.form>
            <div className="editorial-shortcuts">
              <span>Try:</span>
              {["NVDA", "AAPL", "MSFT", "AMZN", "GOOGL"].map((t) => (
                <button key={t} onClick={() => setSymbol(t)}>
                  {t}
                </button>
              ))}
            </div>
            {message && (
              <p className="form-message" role="status">
                {message}
              </p>
            )}
            <p className="editorial-note">
              A considered starting point for your own research — not financial
              advice.
            </p>
          </div>
          <motion.div
            className="brief-artifact"
            initial={{ opacity: 0, x: 35 }}
            animate={{
              opacity: 1,
              x: 0,
              transition: { delay: 0.22, duration: 0.8 },
            }}
          >
            <div className="artifact-bar">
              <span>● ● ●</span>
              <small>ILLUSTRATIVE REPORT</small>
              <small>UPDATED 10:24 UTC</small>
            </div>
            <div className="artifact-title">
              <div>
                <span>RESEARCH BRIEF</span>
                <b>NVDA</b>
              </div>
              <strong>+ MARKET VIEW</strong>
            </div>
            <div className="artifact-body">
              <aside>
                {[
                  "EXECUTIVE SUMMARY",
                  "INVESTMENT THESIS",
                  "MARKET & TECHNICAL",
                  "FUNDAMENTALS",
                  "NEWS & SENTIMENT",
                  "BULL VS BEAR",
                  "TRADER PLAN",
                  "RISK REVIEW",
                  "PORTFOLIO MANAGER",
                  "FINAL VIEW",
                ].map((x, i) => (
                  <span className={i === 0 ? "active" : ""} key={x}>
                    {String(i + 1).padStart(2, "0")} {x}
                  </span>
                ))}
              </aside>
              <div className="artifact-content">
                <span className="artifact-label">EXECUTIVE SUMMARY</span>
                <h2>
                  Evidence before
                  <br />
                  <em>conviction.</em>
                </h2>
                <p>
                  Context, opposing views and risk questions assembled into one
                  readable brief.
                </p>
                <div className="evidence-list">
                  {[
                    "Market context",
                    "Fundamentals",
                    "Opposing views",
                    "Risk review",
                  ].map((x, i) => (
                    <div key={x}>
                      <span>{x}</span>
                      <i style={{ width: `${64 + i * 8}%` }} />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </motion.div>
        </section>
        <section className="editorial-research-system" id="how-it-works">
          <div className="editorial-section-head">
            <span>How the brief is built</span>
            <h2>
              From one ticker
              <br />
              <em>to one clear brief.</em>
            </h2>
            <p>
              Follow one company through twelve specialist roles. Each hand-off
              adds evidence, challenges the thesis and keeps uncertainty visible
              before the final synthesis is assembled.
            </p>
          </div>
          <div className="research-system-grid">
            <div
              className={`agent-network${demoIsRunning ? " is-running" : ""}`}
              id="agents"
              style={
                {
                  "--agent-progress": `${
                    demoStage < 0
                      ? 0
                      : Math.min(1, (demoStage + 1) / agents.length)
                  }`,
                } as CSSProperties
              }
            >
              <div className="agent-network-head">
                <span>Twelve-specialist research desk</span>
                <div
                  className="agent-network-status"
                  role="status"
                  aria-live="polite"
                >
                  <span>
                    {demoStage < 0
                      ? "Demo ready"
                      : demoIsRunning
                        ? `Researching ${demoSymbol}`
                        : `${demoSymbol} demo complete`}
                  </span>
                  <b>
                    {demoStage < 0
                      ? "Run the demo above"
                      : demoIsRunning
                        ? (agents[demoStage]?.[1] ?? "Research in progress")
                        : "Illustrative report assembled"}
                  </b>
                </div>
              </div>
              <div className="agent-network-spine" aria-hidden="true">
                <i />
              </div>
              <div className="agent-network-list">
                {agents.map(([number, name, description], i) => (
                  <motion.article
                    key={name}
                    className={`${demoStage > i ? "is-complete" : ""}${
                      demoStage === i ? " is-active" : ""
                    }`}
                    whileInView={{ opacity: 1, x: 0 }}
                    initial={{ opacity: 0, x: i % 2 ? 18 : -18 }}
                    viewport={{ once: true, margin: "-45px" }}
                    transition={{ delay: i * 0.07 }}
                  >
                    <span>{number}</span>
                    <div>
                      <h3>{name}</h3>
                      <p>{description}</p>
                    </div>
                    <i aria-hidden="true" />
                  </motion.article>
                ))}
              </div>
              <div
                className={`agent-network-output${
                  demoStage === agents.length ? " is-ready" : ""
                }`}
              >
                <FileText size={18} />
                <span>Portfolio-manager synthesis</span>
                <b>
                  {demoStage === agents.length
                    ? `${demoSymbol} illustrative report ready`
                    : "One readable report"}
                </b>
              </div>
            </div>
          </div>
        </section>

        <ResearchCoverage />

        <section className="editorial-report" id="reports">
          <div className="editorial-section-head">
            <span>04 / The output</span>
            <h2>
              Not a score.
              <br />
              <em>A research brief.</em>
            </h2>
            <p>
              Illustrative only. The finished report keeps the evidence, debate
              and uncertainty together.
            </p>
          </div>
          <div className="report-card">
            <div className="report-card-top">
              <b>NVDA / Illustrative report</b>
              <span>FINAL VIEW</span>
            </div>
            <div className="report-card-grid">
              <div>
                <span>EXECUTIVE SUMMARY</span>
                <h3>
                  Evidence first.
                  <br />
                  <em>Noise second.</em>
                </h3>
                <p>
                  A structured first read across market context, fundamentals,
                  news, sentiment, opposing research and risk review.
                </p>
              </div>
              <div className="report-columns">
                {[
                  "Investment thesis",
                  "Market & technical",
                  "Fundamentals",
                  "News & sentiment",
                  "Bull vs Bear",
                  "Trader plan",
                  "Risk review",
                  "Portfolio Manager",
                  "Final view",
                ].map((x) => (
                  <div key={x}>
                    <span>{x}</span>
                    <i />
                    <i />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>
        <section className="editorial-credits" id="pricing">
          <div className="editorial-section-head">
            <span>05 / Credits</span>
            <h2>
              Research when
              <br />
              <em>you need it.</em>
            </h2>
            <p>
              No subscription decision yet. Buy analysis credits when pricing
              is ready — referral rewards are not available in this release.
            </p>
          </div>
          <div className="credit-list">
            <article>
              <b className="credit-number">5</b>
              <div>
                <b>Analysis credits</b>
                <p>For the next five companies on your list.</p>
              </div>
              <button onClick={credits}>
                Price coming soon <ArrowUpRight size={15} />
              </button>
            </article>
            <article>
              <b className="credit-number">10</b>
              <div>
                <b>Analysis credits</b>
                <p>More room for a steady research habit.</p>
              </div>
              <button onClick={credits}>
                Price coming soon <ArrowUpRight size={15} />
              </button>
            </article>
          </div>
        </section>
        <section className="editorial-final">
          <span>Start with a question</span>
          <h2>
            Choose the company.
            <br />
            <em>We’ll map the story.</em>
          </h2>
          <Link to="/auth" className="editorial-cta">
            Open your workspace <ArrowUpRight size={17} />
          </Link>
        </section>
      </main>
    </Shell>
  );
}
