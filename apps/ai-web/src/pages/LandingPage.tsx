import { FormEvent, useState } from "react";
import {
  ArrowUpRight,
  BarChart3,
  Check,
  ChevronRight,
  CircleAlert,
  FileText,
  Network,
  Search,
  Shield,
} from "lucide-react";
import { motion } from "motion/react";
import { Link } from "react-router-dom";
import { Shell } from "../components/layout/Shell";
import { Atmosphere } from "../components/visual/Atmosphere";
import { SponsorRail } from "../components/sponsors/SponsorRail";

const agents = [
  ["01", "Market context", "Macro, industry and competitive signals."],
  ["02", "Fundamentals", "Earnings quality, margins and capital."],
  ["03", "News & sentiment", "What changed — and how investors reacted."],
  ["04", "Bull case", "The strongest evidence for the upside."],
  ["05", "Bear case", "The assumptions most likely to break."],
  ["06", "Risk review", "Uncertainty, downside and open questions."],
  ["07", "PM synthesis", "One structured brief, ready to read."],
] as const;

export function LandingPage() {
  const [symbol, setSymbol] = useState("");
  const [message, setMessage] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setMessage("Backend connection not configured yet.");
  };
  const credits = () =>
    setMessage("Credit checkout will connect to Stripe soon.");
  const workflow = [
    [Search, "Choose a stock"],
    [Network, "Gather evidence"],
    [BarChart3, "Challenge assumptions"],
    [Shield, "Risk review"],
    [FileText, "Final report"],
  ] as const;
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
              Seven specialised agents investigate one company from different
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
              <button type="submit">
                Analyse <ArrowUpRight size={16} />
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
                  "BULL CASE",
                  "BEAR CASE",
                  "FUNDAMENTALS",
                  "RISK REVIEW",
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
              Five stages move the evidence forward. Seven specialists work on
              the same company, challenge one another and hand one synthesis to
              you.
            </p>
          </div>
          <div className="research-system-grid">
            <div className="workflow-line" aria-label="Research workflow">
              {workflow.map(([Icon, label], i) => (
                <motion.div
                  className="workflow-step"
                  key={label}
                  whileInView={{ opacity: 1, x: 0 }}
                  initial={{ opacity: 0, x: -18 }}
                  viewport={{ once: true, margin: "-70px" }}
                  transition={{ delay: i * 0.09 }}
                >
                  <span>{String(i + 1).padStart(2, "0")}</span>
                  <Icon />
                  <div>
                    <b>{label}</b>
                    <small>
                      {i === 0
                        ? "Enter a ticker to begin."
                        : i === 1
                          ? "Specialists investigate the company."
                          : i === 2
                            ? "Opposing views test the thesis."
                            : i === 3
                              ? "Uncertainty stays visible."
                              : "One structured brief is assembled."}
                    </small>
                  </div>
                  {i < 4 && <ChevronRight className="workflow-arrow" />}
                </motion.div>
              ))}
            </div>
            <div className="agent-network" id="agents">
              <div className="agent-network-head">
                <span>Seven-agent research team</span>
                <b>One shared evidence room</b>
              </div>
              <div className="agent-network-spine" aria-hidden="true">
                <i />
              </div>
              <div className="agent-network-list">
                {agents.map(([number, name, description], i) => (
                  <motion.article
                    key={name}
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
              <div className="agent-network-output">
                <FileText size={18} />
                <span>Portfolio-manager synthesis</span>
                <b>One readable report</b>
              </div>
            </div>
          </div>
        </section>
        <section className="editorial-debate">
          <div className="editorial-section-head">
            <span>03 / The debate</span>
            <h2>
              Good research
              <br />
              <em>argues with itself.</em>
            </h2>
            <p>
              Bull and Bear researchers work from the same evidence, then make
              the disagreement explicit for Risk to review.
            </p>
          </div>
          <div className="debate-panels">
            <article className="debate-panel bull">
              <span>04 / Bull case</span>
              <h3>What could go right?</h3>
              <ul>
                <li>
                  <Check />
                  Demand and catalysts
                </li>
                <li>
                  <Check />
                  Execution and margins
                </li>
                <li>
                  <Check />
                  Evidence that supports upside
                </li>
              </ul>
            </article>
            <div className="debate-vs">
              VS
              <div>
                <Shield size={18} />
                <span>
                  Risk
                  <br />
                  review
                </span>
              </div>
            </div>
            <article className="debate-panel bear">
              <span>05 / Bear case</span>
              <h3>What are we missing?</h3>
              <ul>
                <li>
                  <CircleAlert />
                  Valuation and expectations
                </li>
                <li>
                  <CircleAlert />
                  Competition and fragility
                </li>
                <li>
                  <CircleAlert />
                  Evidence that changes the view
                </li>
              </ul>
            </article>
          </div>
        </section>
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
                  news, opposing research and risk review.
                </p>
              </div>
              <div className="report-columns">
                {[
                  "Investment thesis",
                  "Bull case",
                  "Bear case",
                  "Fundamentals",
                  "Market context",
                  "Risk review",
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
              No subscription decision yet. Choose credits, or invite someone
              into the research room.
            </p>
          </div>
          <div className="credit-list">
            <article>
          <Network />
              <div>
                <b>Invite a friend</b>
                <p>
                  When they register and complete their first analysis, you
                  receive one analysis credit.
                </p>
              </div>
              <Link to="/account">
                Invite <ArrowUpRight size={15} />
              </Link>
            </article>
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
