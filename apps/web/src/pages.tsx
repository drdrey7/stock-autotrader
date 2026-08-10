import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  CalendarDays,
  Check,
  ChevronRight,
  CircleDot,
  Database,
  FlaskConical,
  Gauge,
  LineChart,
  LockKeyhole,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Target,
  Zap,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type { Candidate } from "@stock-autotrader/contracts";
import { useData } from "./lib/data-context";
import {
  Badge,
  MetricCard,
  PublicFooter,
  Rationale,
  SectionHeading,
  SignalBadge,
} from "./components";
import { formatDate, formatMoney } from "./lib/format";

const features = [
  [
    Search,
    "Market-wide scanning",
    "A rules-based universe removes illiquid securities before strategies begin.",
  ],
  [
    Target,
    "Systematic strategies",
    "Versioned strategy logic evaluates every eligible stock in the same way.",
  ],
  [
    Zap,
    "Earnings & events",
    "Event timing and price reactions are checked before a setup can pass.",
  ],
  [
    ShieldCheck,
    "Risk management",
    "Position size and portfolio limits remain deterministic and outside AI.",
  ],
  [
    Database,
    "Transparent methodology",
    "Every decision stores structured pass and rejection reasons.",
  ],
  [
    LineChart,
    "Shadow performance",
    "Signals are tested with simulated capital before any future broker link.",
  ],
] as const;

const signedPercent = (value: number) => `${value >= 0 ? "+" : ""}${value}%`;
const signedMoney = (value: number) =>
  `${value >= 0 ? "+" : ""}${formatMoney(value)}`;

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function LandingPreview() {
  const demoData = useData();
  const { scan, portfolio } = demoData;
  return (
    <div className="hero-preview">
      <div className="preview-top">
        <div>
          <span
            className={
              demoData.status.engine === "online"
                ? "preview-dot"
                : "event-dot event-warning"
            }
          />{" "}
          Engine {demoData.status.engine}
        </div>
        <Badge tone="demo">Demo Data</Badge>
      </div>
      <div className="preview-metrics">
        <div>
          <span>Stocks analysed</span>
          <strong>{scan.universe.toLocaleString()}</strong>
        </div>
        <div>
          <span>Surfaced</span>
          <strong>{scan.candidates}</strong>
        </div>
        <div>
          <span>Strong setups</span>
          <strong>{scan.setups}</strong>
        </div>
        <div>
          <span>Shadow portfolio</span>
          <strong>{formatMoney(portfolio.equity)}</strong>
          <small>
            {portfolio.returnPct >= 0 ? "+" : ""}
            {portfolio.returnPct}%
          </small>
        </div>
      </div>
      <div className="preview-table">
        <div className="preview-row preview-header">
          <span>Symbol</span>
          <span>Score</span>
          <span>Model signal</span>
        </div>
        {demoData.candidates
          .filter((c) => c.status === "Strong Setup")
          .slice(0, 3)
          .map((c) => (
            <div className="preview-row" key={`${c.symbol}:${c.strategyId}`}>
              <span>
                <strong>{c.symbol}</strong>
                <small>{c.company}</small>
              </span>
              <span>
                <strong>{c.quantScore}</strong>/100
              </span>
              <span>
                <SignalBadge status={c.status} />
              </span>
            </div>
          ))}
      </div>
    </div>
  );
}

export function LandingPage() {
  const demoData = useData();
  return (
    <div className="landing">
      <header className="landing-nav">
        <Link to="/" className="brand">
          <span className="brand-mark">
            <BarChart3 size={19} />
          </span>
          <span>
            Stock Autotrader<small>Systematic Research</small>
          </span>
        </Link>
        <nav>
          <a href="#overview">Overview</a>
          <a href="#strategies">Strategies</a>
          <a href="#analysis">Analysis</a>
          <a href="#research">Research</a>
          <a href="#about">About</a>
        </nav>
        <Link className="button button-small" to="/dashboard">
          View Live Dashboard
        </Link>
      </header>
      <main>
        <section className="hero" id="overview">
          <div className="hero-copy">
            <Badge tone="positive">
              <CircleDot size={12} /> US market research engine
            </Badge>
            <h1>
              Data. Analysis.
              <br />
              <em>Opportunity.</em>
            </h1>
            <p>
              Systematic stock research scanning the US market for high-quality
              swing trading setups.
            </p>
            <p className="hero-tagline">
              We scan the market. You see what matters.
            </p>
            <div className="hero-actions">
              <Link className="button" to="/dashboard">
                View Live Dashboard <ArrowRight size={17} />
              </Link>
              <a className="button button-secondary" href="#method">
                How It Works
              </a>
            </div>
            <div className="trust-row">
              <span>
                <Check /> Read-only
              </span>
              <span>
                <Check /> Auditable decisions
              </span>
              <span>
                <Check /> Simulated capital
              </span>
            </div>
          </div>
          <LandingPreview />
        </section>
        <section className="section" id="method">
          <SectionHeading
            eyebrow="A disciplined process"
            title="From the whole market to a clear decision"
            text="The engine narrows the universe before any event or AI assessment. Hard risk rules always stay deterministic."
          />
          <div className="process">
            <div>
              <span>01</span>
              <strong>Filter</strong>
              <p>
                Liquidity, price and market-cap rules build the eligible
                universe.
              </p>
            </div>
            <ChevronRight />
            <div>
              <span>02</span>
              <strong>Measure</strong>
              <p>Trend, momentum, relative strength, volume and volatility.</p>
            </div>
            <ChevronRight />
            <div>
              <span>03</span>
              <strong>Decide</strong>
              <p>Versioned strategies produce an auditable quant signal.</p>
            </div>
            <ChevronRight />
            <div>
              <span>04</span>
              <strong>Observe</strong>
              <p>Qualified signals enter a simulated shadow portfolio.</p>
            </div>
          </div>
        </section>
        <section className="section section-tinted" id="analysis">
          <SectionHeading
            eyebrow="Built for evidence"
            title="One public view. No trading controls."
            text="The website explains what the engine observed without exposing private infrastructure or model chain-of-thought."
          />
          <div className="feature-grid">
            {features.map(([Icon, title, text]) => (
              <article className="feature-card" key={title}>
                <span className="icon-box">
                  <Icon size={21} />
                </span>
                <h3>{title}</h3>
                <p>{text}</p>
                <Link to="/methodology">
                  Learn more <ArrowRight size={14} />
                </Link>
              </article>
            ))}
          </div>
        </section>
        <section className="section split-section" id="strategies">
          <div>
            <SectionHeading
              eyebrow="Versioned strategies"
              title="Compare ideas without mixing evidence"
              text="Each strategy publishes its rules, lifecycle stage and results independently. New strategies appear from metadata, not hand-built pages."
            />
            <Link className="text-link" to="/strategies">
              Explore strategies <ArrowRight size={16} />
            </Link>
          </div>
          <div className="strategy-stack">
            {demoData.strategies.map((s) => (
              <article key={s.id}>
                <div>
                  <Badge tone={s.state === "Shadow" ? "positive" : "neutral"}>
                    {s.state}
                  </Badge>
                  <span>v{s.version}</span>
                </div>
                <h3>{s.name} V1</h3>
                <p>{s.description}</p>
                <div>
                  <span>{s.universe}</span>
                  <span>{s.holdingPeriod}</span>
                  <strong>
                    {s.signalsToday} setup{s.signalsToday === 1 ? "" : "s"}{" "}
                    today
                  </strong>
                </div>
              </article>
            ))}
          </div>
        </section>
        <section className="section section-dark" id="research">
          <div>
            <Badge tone="demo">Research contract</Badge>
            <h2>Performance needs context.</h2>
            <p>
              Research, validation, final out-of-sample and shadow results are
              kept separate. 2026 data cannot be used to choose parameters.
            </p>
            <Link className="button button-light" to="/research">
              Open Research <ArrowRight size={17} />
            </Link>
          </div>
          <div className="periods">
            <div>
              <span>Research</span>
              <strong>2010–2024</strong>
            </div>
            <div>
              <span>Validation</span>
              <strong>2025</strong>
            </div>
            <div>
              <span>Final out-of-sample</span>
              <strong>2026 → current</strong>
            </div>
            <small>
              Demo metrics are explicitly labelled and are not claims of
              performance.
            </small>
          </div>
        </section>
        <section className="section recent" id="about">
          <SectionHeading
            eyebrow="Latest from the engine"
            title="Recent analyses"
            action={
              <Link className="text-link" to="/signals">
                View signals <ArrowRight size={16} />
              </Link>
            }
          />
          <div className="analysis-grid">
            {demoData.candidates.slice(0, 3).map((c) => (
              <Link
                to={`/stocks/${c.symbol}?strategy=${encodeURIComponent(c.strategyId)}`}
                className="analysis-card"
                key={c.symbol}
              >
                <div>
                  <span className="ticker-icon">{c.symbol.slice(0, 1)}</span>
                  <span>
                    <strong>{c.symbol}</strong>
                    <small>{c.company}</small>
                  </span>
                  <SignalBadge status={c.status} />
                </div>
                <div>
                  <span>Quant score</span>
                  <strong>
                    {c.quantScore}
                    <small>/100</small>
                  </strong>
                </div>
                <div className="score-bar">
                  <i style={{ width: `${c.quantScore}%` }} />
                </div>
                <footer>
                  <span>{c.strategy}</span>
                  <ArrowRight size={16} />
                </footer>
              </Link>
            ))}
          </div>
        </section>
      </main>
      <PublicFooter />
    </div>
  );
}

export function DashboardPage() {
  const demoData = useData();
  const { status, scan, portfolio, candidates, earnings } = demoData;
  const strong = candidates.filter((c) => c.status === "Strong Setup");
  const watch = candidates.filter((c) => c.status === "Watch");
  const relevantEarnings = earnings.filter((e) => e.engineRelevant);
  return (
    <>
      <PageTitle
        eyebrow="Today's market brief"
        title="What matters today"
        text="A daily view of the strongest signals, watch candidates and events the engine is tracking."
        action={<Badge tone="demo">Demo Data</Badge>}
      />
      <div className="brief-grid">
        <div>
          <span>Last scan</span>
          <strong>{formatDate(status.latestScan)}</strong>
        </div>
        <div>
          <span>Stocks analysed</span>
          <strong>{scan.universe.toLocaleString()}</strong>
        </div>
        <div>
          <span>Strong setups</span>
          <strong>{scan.setups}</strong>
        </div>
        <div>
          <span>Watch candidates</span>
          <strong>{scan.watch}</strong>
        </div>
        <div>
          <span>Shadow positions</span>
          <strong>{portfolio.openPositions}</strong>
        </div>
        <div>
          <span>Relevant earnings</span>
          <strong>{relevantEarnings.length}</strong>
        </div>
      </div>
      <div className="dashboard-grid">
        <section className="panel panel-large">
          <SectionHeading
            title="Strong Setups Today"
            action={<Link to="/signals">All signals</Link>}
          />
          <CandidateList candidates={strong} />
        </section>
        <section className="panel">
          <SectionHeading
            title="Watch Closely"
            action={<Link to="/signals">Signals</Link>}
          />
          <CandidateList candidates={watch} />
        </section>
        <section className="panel">
          <SectionHeading
            title="Shadow Portfolio"
            action={<Link to="/portfolio">Details</Link>}
          />
          <div className="portfolio-hero">
            <span>Simulated equity</span>
            <strong>{formatMoney(portfolio.equity)}</strong>
            <Badge tone={portfolio.returnPct >= 0 ? "positive" : "negative"}>
              {signedPercent(portfolio.returnPct)}
            </Badge>
          </div>
          <div className="mini-stats">
            <span>
              Open positions<strong>{portfolio.openPositions}</strong>
            </span>
            <span>
              Open risk<strong>{portfolio.openRiskPct}%</strong>
            </span>
            <span>
              Starting capital
              <strong>{formatMoney(portfolio.initialCapital)}</strong>
            </span>
          </div>
        </section>
        <section className="panel">
          <SectionHeading
            title="Relevant Earnings"
            action={<Link to="/earnings">Calendar</Link>}
          />
          <div className="earnings-mini">
            {relevantEarnings.map((e) => (
              <Link to={`/stocks/${e.symbol}`} key={e.symbol}>
                <span>
                  <strong>{e.symbol}</strong>
                  <small>
                    {e.date} · {e.timing}
                  </small>
                </span>
                {e.signal && <SignalBadge status={e.signal} />}
              </Link>
            ))}
          </div>
        </section>
        <section className="panel panel-large">
          <SectionHeading
            title="Recent Engine Activity"
            action={<Link to="/activity">All activity</Link>}
          />
          <Timeline compact />
        </section>
      </div>
    </>
  );
}

function PageTitle({
  eyebrow,
  title,
  text,
  action,
}: {
  eyebrow: string;
  title: string;
  text: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="page-title">
      <div>
        <span className="eyebrow accent-text">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{text}</p>
      </div>
      {action}
    </div>
  );
}

function CandidateList({ candidates }: { candidates: Candidate[] }) {
  if (candidates.length === 0) {
    return (
      <div className="empty-state">
        <Search />
        <strong>No candidates right now</strong>
        <p className="muted">Check back after the next scan.</p>
      </div>
    );
  }
  return (
    <div className="candidate-list">
      {candidates.map((c) => (
        <Link
          to={`/stocks/${c.symbol}?strategy=${encodeURIComponent(c.strategyId)}`}
          key={`${c.symbol}:${c.strategyId}`}
        >
          <span className="ticker-icon">{c.symbol[0]}</span>
          <span>
            <strong>{c.symbol}</strong>
            <small>{c.company}</small>
          </span>
          <span className="candidate-strategy">{c.strategy}</span>
          <span className="score">
            <strong>{c.quantScore}</strong>/100
          </span>
          <SignalBadge status={c.status} />
          <ChevronRight size={16} />
        </Link>
      ))}
    </div>
  );
}

function SignalSection({
  title,
  note,
  candidates,
}: {
  title: string;
  note?: string;
  candidates: Candidate[];
}) {
  if (candidates.length === 0) return null;
  return (
    <section className="panel signal-section">
      <SectionHeading title={title} text={note} />
      <div className="responsive-table signal-table">
        <div className="table-row table-head">
          <span>Stock</span>
          <span>Score</span>
          <span>Strategy</span>
          <span>Model signal</span>
          <span>Trend</span>
          <span>Breakout</span>
          <span>Earnings</span>
          <span>Updated</span>
        </div>
        {candidates.map((c) => (
          <Link
            to={`/stocks/${c.symbol}?strategy=${encodeURIComponent(c.strategyId)}`}
            className="table-row"
            key={`${c.symbol}:${c.strategyId}`}
          >
            <span data-label="Stock">
              <strong>{c.symbol}</strong>
              <small>{c.company}</small>
            </span>
            <span data-label="Score">
              <strong>{c.quantScore}</strong>/100
            </span>
            <span data-label="Strategy">{c.strategy}</span>
            <span data-label="Model signal">
              <SignalBadge status={c.status} />
            </span>
            <span data-label="Trend">{c.trend}</span>
            <span data-label="Breakout">{c.breakout ?? "—"}</span>
            <span data-label="Earnings">{c.earningsDate ?? "—"}</span>
            <span data-label="Updated">{formatDate(c.updatedAt)}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}

export function SignalsPage() {
  const demoData = useData();
  const strong = demoData.candidates.filter(
    (c) => c.status === "Strong Setup",
  );
  const watch = demoData.candidates.filter((c) => c.status === "Watch");
  const rejected = demoData.candidates.filter(
    (c) => c.status === "Rejected" || c.status === "No Setup",
  );
  return (
    <>
      <PageTitle
        eyebrow="Market signals"
        title="Market signals"
        text="The engine scans the broader US equity universe and surfaces only the setups that pass its relevance filters."
        action={<Badge tone="demo">Demo Data</Badge>}
      />
      <div className="signal-summary">
        <span>
          <strong>{demoData.scan.universe.toLocaleString()}</strong> stocks
          analysed
        </span>
        <i />
        <span>
          <strong>{demoData.scan.candidates}</strong> surfaced
        </span>
        <i />
        <span>
          <strong>{demoData.scan.setups}</strong> strong setups
        </span>
      </div>
      <SignalSection title="Strong Setups" candidates={strong} />
      <SignalSection
        title="Watch"
        note="Close to confirmation — a trigger is missing before these qualify."
        candidates={watch}
      />
      <SignalSection
        title="Relevant Rejections"
        note="Why the engine passed on these names — useful for understanding decisions."
        candidates={rejected}
      />
    </>
  );
}

function PriceChart({ score }: { score: number }) {
  return (
    <div
      className="chart-placeholder chart-large"
      role="img"
      aria-label="Prepared OHLCV chart placeholder with candles, volume, moving averages and model levels"
    >
      <div className="chart-grid" />
      <svg viewBox="0 0 800 320" preserveAspectRatio="none">
        <defs>
          <linearGradient id="area" x1="0" y1="0" x2="0" y2="1">
            <stop stopColor="#25745a" />
            <stop offset="1" stopColor="#25745a" stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* EMA20 */}
        <path
          d="M0 250 C60 240,110 244,160 220 S260 226,320 190 S430 200,490 155 S600 168,660 120 S740 132,800 92"
          fill="none"
          stroke="#2f6feb"
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
        />
        {/* EMA50 */}
        <path
          d="M0 262 C70 254,130 256,180 238 S290 240,350 212 S470 218,530 180 S640 188,700 148 S760 152,800 122"
          fill="none"
          stroke="#b45f06"
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
        />
        {/* EMA200 */}
        <path
          d="M0 272 C80 268,150 268,210 256 S330 254,390 234 S520 236,580 208 S690 210,800 178"
          fill="none"
          stroke="#7a7f7d"
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
        />
        {/* area fill under price */}
        <path
          d="M0 212 C60 198,90 218,140 180 S220 190,260 152 S340 174,390 130 S470 148,520 98 S600 116,650 74 S730 88,800 42 L800 320 L0 320Z"
          fill="url(#area)"
          opacity=".18"
        />
        {/* price path */}
        <path
          d="M0 212 C60 198,90 218,140 180 S220 190,260 152 S340 174,390 130 S470 148,520 98 S600 116,650 74 S730 88,800 42"
          fill="none"
          stroke="#1d2b27"
          strokeWidth="2.5"
          vectorEffect="non-scaling-stroke"
        />
        {/* breakout level */}
        <line
          x1="0"
          y1="150"
          x2="800"
          y2="150"
          stroke="#25745a"
          strokeWidth="1.5"
          strokeDasharray="7 5"
          vectorEffect="non-scaling-stroke"
        />
        {/* earnings marker */}
        <line
          x1="455"
          y1="0"
          x2="455"
          y2="320"
          stroke="#b45309"
          strokeWidth="1.5"
          strokeDasharray="3 4"
          vectorEffect="non-scaling-stroke"
        />
        {/* model levels */}
        <line
          x1="600"
          y1="80"
          x2="800"
          y2="80"
          stroke="#b45309"
          strokeWidth="1.2"
          strokeDasharray="2 3"
          vectorEffect="non-scaling-stroke"
        />
        <line
          x1="600"
          y1="205"
          x2="800"
          y2="205"
          stroke="#c0392b"
          strokeWidth="1.2"
          strokeDasharray="2 3"
          vectorEffect="non-scaling-stroke"
        />
        {/* volume bars */}
        {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].map((i) => {
          const x = 30 + i * 52;
          const h = 26 + ((i * 37) % 42);
          const up = (i * 7) % 3 !== 0;
          return (
            <rect
              key={i}
              x={x}
              y={308 - h}
              width="22"
              height={h}
              fill={up ? "#cfe8dc" : "#f3d2cf"}
            />
          );
        })}
      </svg>
      <div className="chart-legend">
        <span>
          <i className="legend-line" style={{ background: "#2f6feb" }} /> EMA20
        </span>
        <span>
          <i className="legend-line" style={{ background: "#b45f06" }} /> EMA50
        </span>
        <span>
          <i className="legend-line" style={{ background: "#7a7f7d" }} /> EMA200
        </span>
        <span>
          <i className="legend-dash" style={{ background: "#25745a" }} /> Breakout
        </span>
        <span>
          <i className="legend-dash" style={{ background: "#b45309" }} /> Earnings
        </span>
      </div>
      <div className="chart-caption">
        <span>Demo OHLCV shape · prepared for live candles and volume</span>
        <strong>Quant score {score}/100</strong>
      </div>
    </div>
  );
}

export function StockPage() {
  const demoData = useData();
  const { symbol = "" } = useParams();
  const [searchParams] = useSearchParams();
  const strategyId = searchParams.get("strategy");
  const symbolCandidates = demoData.candidates.filter(
    (candidate) => candidate.symbol === symbol.toUpperCase(),
  );
  const stock = strategyId
    ? symbolCandidates.find((candidate) => candidate.strategyId === strategyId)
    : [...symbolCandidates].sort(
        (left, right) =>
          right.quantScore - left.quantScore ||
          left.strategyId.localeCompare(right.strategyId),
      )[0];
  if (!stock) return <NotFoundPage />;
  const position = demoData.positions.find((p) => p.symbol === stock.symbol);
  return (
    <>
      <PageTitle
        eyebrow={`${stock.sector} · US Equity`}
        title={stock.symbol}
        text={stock.company}
        action={
          <div className="title-actions">
            <SignalBadge status={stock.status} />
            <Badge tone="neutral">Quant Signal · {stock.direction}</Badge>
          </div>
        }
      />
      <div className="stock-hero">
        <div>
          <span>Price overview</span>
          <strong>{formatMoney(stock.price)}</strong>
          <small>
            {demoData.demo
              ? "Demo snapshot · not live market data"
              : `Public snapshot · updated ${formatDate(stock.updatedAt)}`}
          </small>
        </div>
        <div className="stock-hero-meta">
          <span>
            Strategy<strong>{stock.strategy} V1</strong>
          </span>
          <span>
            Last updated<strong>{formatDate(stock.updatedAt)}</strong>
          </span>
        </div>
        <div
          className="score-ring"
          style={
            { "--score": `${stock.quantScore * 3.6}deg` } as React.CSSProperties
          }
        >
          <span>
            <strong>{stock.quantScore}</strong>/100
          </span>
        </div>
      </div>
      <section className="panel panel-full">
        <SectionHeading
          title="Price structure"
          text={
            demoData.demo
              ? "The chart is prepared for live OHLCV, candles, volume, moving averages and model levels. Demo shape shown."
              : "The OHLCV adapter is prepared; no chart series was included in this public snapshot."
          }
        />
        <PriceChart score={stock.quantScore} />
      </section>
      <div className="stock-grid">
        <section className="panel panel-large">
          <SectionHeading title="Quant Factors" />
          <div className="factor-grid">
            <MetricCard label="Trend" value={stock.trend} detail="EMA structure" />
            <MetricCard
              label="Momentum"
              value={stock.momentum}
              detail="Composite score"
            />
            <MetricCard
              label="Relative strength"
              value={stock.relativeStrength}
              detail="vs SPY / QQQ"
            />
            <MetricCard
              label="Volume"
              value={`${stock.relativeVolume}x`}
              detail="vs ADV20"
            />
            <MetricCard
              label="Volatility"
              value="Medium"
              detail="ATR% regime"
            />
            <MetricCard
              label="Breakout"
              value={stock.breakout ?? "None"}
              detail="Recent price structure"
            />
          </div>
        </section>
        <section className="panel">
          <SectionHeading
            title={
              stock.status === "Rejected"
                ? "Why it was rejected"
                : "Why it surfaced"
            }
            text="Public, structured rationale — never private chain-of-thought."
          />
          <Rationale reasons={stock.reasons} />
        </section>
        {stock.riskFlags.length > 0 && (
          <section className="panel">
            <SectionHeading
              title="Risks / blockers"
              text="Conditions the engine watches before and after a setup."
            />
            <div className="risk-flag-list">
              {stock.riskFlags.map((flag) => (
                <span key={flag}>
                  <AlertTriangle size={15} />
                  {flag}
                </span>
              ))}
            </div>
          </section>
        )}
        <section className="panel">
          <SectionHeading title="Earnings & events" />
          <div className="event-callout">
            <CalendarDays />
            <div>
              <strong>{stock.earningsDate ?? "Date unavailable"}</strong>
              <span>
                {stock.earningsProximityDays !== null &&
                stock.earningsProximityDays > 0
                  ? `${stock.earningsProximityDays} days away`
                  : stock.earningsProximityDays === 0
                    ? "Today (event window)"
                    : "Recent event"}
              </span>
            </div>
          </div>
          <p className="muted">
            Timing (BMO / AMC) and event analysis arrive with the future
            earnings provider.
          </p>
        </section>
        <section className="panel">
          <SectionHeading title="Strategy" />
          <Link
            className="strategy-link"
            to={`/strategies/${stock.strategyId}`}
          >
            <Target />
            <span>
              <strong>{stock.strategy} V1</strong>
              <small>
                Version {stock.strategyVersion} · {stock.status}
              </small>
            </span>
            <ChevronRight />
          </Link>
          {position && (
            <div className="detail-list">
              <span>
                Shadow position<strong>Open · {position.quantity} shares</strong>
              </span>
              <span>
                Unrealized P&L
                <strong
                  className={
                    position.unrealizedPnl >= 0
                      ? "positive-text"
                      : "negative-text"
                  }
                >
                  {signedMoney(position.unrealizedPnl)}
                </strong>
              </span>
            </div>
          )}
        </section>
        <section className="panel panel-full">
          <SectionHeading title="Latest decisions" />
          <Timeline compact symbol={stock.symbol} />
        </section>
      </div>
    </>
  );
}

export function StrategiesPage() {
  const demoData = useData();
  return (
    <>
      <PageTitle
        eyebrow="Strategy registry"
        title="Systematic strategies"
        text="Every strategy is versioned and evaluated against the same rules."
        action={<Badge tone="demo">Demo Data</Badge>}
      />
      <div className="strategy-grid">
        {demoData.strategies.map((s) => (
          <Link to={`/strategies/${s.id}`} className="strategy-card" key={s.id}>
            <header>
              <span className="icon-box">
                <Target />
              </span>
              <Badge tone={s.state === "Shadow" ? "positive" : "neutral"}>
                {s.state}
              </Badge>
            </header>
            <span className="eyebrow">
              {s.id} · v{s.version}
            </span>
            <h2>{s.name} V1</h2>
            <p>{s.description}</p>
            <div className="detail-list">
              <span>
                Universe<strong>{s.universe}</strong>
              </span>
              <span>
                Typical holding period<strong>{s.holdingPeriod}</strong>
              </span>
              <span>
                Signals today<strong>{s.signalsToday}</strong>
              </span>
              <span>
                Open shadow positions<strong>{s.openPositions}</strong>
              </span>
            </div>
            <footer>
              View strategy <ArrowRight />
            </footer>
          </Link>
        ))}
      </div>
    </>
  );
}

export function StrategyPage() {
  const demoData = useData();
  const { strategyId } = useParams();
  const strategy = demoData.strategies.find((s) => s.id === strategyId);
  if (!strategy) return <NotFoundPage />;
  const candidates = demoData.candidates.filter(
    (c) => c.strategyId === strategy.id,
  );
  return (
    <>
      <PageTitle
        eyebrow={`${strategy.id} · v${strategy.version}`}
        title={`${strategy.name} V1`}
        text={strategy.description}
        action={
          <Badge tone={strategy.state === "Shadow" ? "positive" : "neutral"}>
            {strategy.state}
          </Badge>
        }
      />
      <div className="metrics-grid">
        <MetricCard label="Signals today" value={strategy.signalsToday} />
        <MetricCard
          label="Open shadow positions"
          value={strategy.openPositions}
        />
        <MetricCard label="Universe" value="US Core" detail={strategy.universe} />
        <MetricCard
          label="Typical holding period"
          value={strategy.holdingPeriod}
        />
      </div>
      <div className="dashboard-grid">
        <section className="panel panel-large">
          <SectionHeading title="Current signals" />
          <CandidateList candidates={candidates} />
        </section>
        <section className="panel">
          <SectionHeading
            title="Strategy parameters"
            text="Baseline parameters, not optimised claims."
          />
          <div className="detail-list">
            {Object.entries(strategy.parameters).map(([key, value]) => (
              <span key={key}>
                {key}
                <strong>{String(value)}</strong>
              </span>
            ))}
          </div>
        </section>
        <section className="panel">
          <SectionHeading title="Lifecycle" />
          <div className="lifecycle">
            {(
              [
                "Research",
                "Validation",
                "Out-of-Sample",
                "Shadow",
                "Live",
              ] as const
            ).map((stage, index, stages) => {
              const current = stages.indexOf(strategy.state);
              return (
                <span
                  key={stage}
                  className={
                    index < current ? "done" : index === current ? "active" : ""
                  }
                >
                  {stage}
                </span>
              );
            })}
          </div>
        </section>
        <section className="panel panel-large">
          <SectionHeading
            title="Methodology"
            text="Signal rules, shadow performance and backtest results will appear here as they are validated."
          />
          <Rationale
            reasons={
              demoData.candidates.find((c) => c.strategyId === strategy.id)
                ?.reasons ?? []
            }
          />
          <Link className="text-link" to="/methodology">
            Read complete methodology <ArrowRight />
          </Link>
        </section>
      </div>
    </>
  );
}

const metricLabels: Record<string, string> = {
  cagr: "CAGR",
  totalReturn: "Total return",
  maxDrawdown: "Max drawdown",
  profitFactor: "Profit factor",
  expectancy: "Expectancy",
  sharpe: "Sharpe",
  sortino: "Sortino",
  calmar: "Calmar",
  trades: "Trades",
  winRate: "Win rate",
  averageWin: "Average win",
  averageLoss: "Average loss",
  exposure: "Exposure",
  averageHoldingPeriod: "Avg. holding period",
};
export function ResearchPage() {
  const demoData = useData();
  return (
    <>
      <PageTitle
        eyebrow="Evidence library"
        title="Research"
        text="How each strategy is tested — results stay separated by lifecycle stage."
        action={
          <Badge tone={demoData.demo ? "demo" : "neutral"}>
            {demoData.demo ? "Demo metrics" : "Public research results"}
          </Badge>
        }
      />
      <div className="research-warning">
        <FlaskConical />
        <p>
          <strong>Research contract enforced.</strong> 2026 data is reserved for
          final out-of-sample evaluation and cannot select parameters.
        </p>
        <Link to="/methodology">Read contract</Link>
      </div>
      <div className="research-table table-card">
        <div className="table-row table-head">
          <span>Strategy</span>
          <span>Stage</span>
          <span>Period</span>
          <span>CAGR</span>
          <span>Max drawdown</span>
          <span>Sharpe</span>
          <span>Trades</span>
          <span>Status</span>
        </div>
        {demoData.research.map((r) => (
          <Link className="table-row" to={`/research/${r.id}`} key={r.id}>
            <span data-label="Strategy">
              <strong>{r.strategy}</strong>
              <small>NORMAL cost scenario</small>
            </span>
            <span data-label="Stage">
              <Badge>{r.stage}</Badge>
            </span>
            <span data-label="Period">{r.period}</span>
            <span data-label="CAGR">{r.metrics.cagr}%</span>
            <span data-label="Max drawdown">{r.metrics.maxDrawdown}%</span>
            <span data-label="Sharpe">{r.metrics.sharpe}</span>
            <span data-label="Trades">{r.metrics.trades}</span>
            <span data-label="Status">
              <Badge tone="demo">{r.status}</Badge>
            </span>
          </Link>
        ))}
      </div>
      <div className="benchmark-panel">
        <SectionHeading
          title="Benchmark comparison prepared"
          text="Backtest contracts support Strategy, SPY and QQQ with LOW_COST, NORMAL and STRESS execution scenarios."
        />
        <div>
          <span>Strategy</span>
          <span>SPY</span>
          <span>QQQ</span>
        </div>
      </div>
    </>
  );
}

export function ResearchDetailPage() {
  const demoData = useData();
  const { researchId } = useParams();
  const result = demoData.research.find((r) => r.id === researchId);
  if (!result) return <NotFoundPage />;
  return (
    <>
      <PageTitle
        eyebrow={`${result.stage} · ${result.period}`}
        title={result.strategy}
        text={
          demoData.demo
            ? "Illustrative demo output until validated point-in-time market data is connected."
            : "Published research output for the stated lifecycle stage and period."
        }
        action={
          <Badge tone={demoData.demo ? "demo" : "neutral"}>
            {demoData.demo ? "Demo results" : result.status}
          </Badge>
        }
      />
      <div className="metric-detail-grid">
        {Object.entries(result.metrics).map(([key, value]) => (
          <MetricCard
            key={key}
            label={metricLabels[key] ?? key}
            value={
              value === null
                ? "—"
                : `${value}${["cagr", "totalReturn", "maxDrawdown", "winRate", "averageWin", "averageLoss", "exposure"].includes(key) ? "%" : ""}`
            }
          />
        ))}
      </div>
      <section className="panel">
        <SectionHeading title="Validation boundaries" />
        <div className="period-timeline">
          <span className="active">
            <strong>Research</strong>2010–2024
          </span>
          <span>
            <strong>Validation</strong>2025
          </span>
          <span>
            <strong>Final OOS</strong>2026 → current
          </span>
          <span>
            <strong>Shadow</strong>Pending
          </span>
          <span>
            <strong>Live</strong>Not enabled
          </span>
        </div>
      </section>
    </>
  );
}

export function PortfolioPage() {
  const demoData = useData();
  const { portfolio, positions } = demoData;
  return (
    <>
      <PageTitle
        eyebrow="Simulated execution"
        title="Shadow Portfolio"
        text="Virtual positions only. No broker connection and no real capital."
        action={<Badge tone="warning">Simulated</Badge>}
      />
      <div className="portfolio-banner">
        <div>
          <span>Shadow equity</span>
          <strong>{formatMoney(portfolio.equity)}</strong>
          <Badge tone={portfolio.returnPct >= 0 ? "positive" : "negative"}>
            {signedPercent(portfolio.returnPct)}
          </Badge>
        </div>
        <div>
          <span>
            Starting capital
            <strong>{formatMoney(portfolio.initialCapital)}</strong>
          </span>
          <span>
            Cash<strong>{formatMoney(portfolio.cash)}</strong>
          </span>
          <span>
            Invested<strong>{formatMoney(portfolio.invested)}</strong>
          </span>
          <span>
            Open positions
            <strong>
              {portfolio.openPositions} / {portfolio.maxPositions}
            </strong>
          </span>
          <span>
            Open risk
            <strong>
              {portfolio.openRiskPct}% / {portfolio.maxOpenRiskPct}%
            </strong>
          </span>
          <span>
            Gross exposure
            <strong>
              {portfolio.grossExposurePct.toFixed(1)}% /{" "}
              {portfolio.maxGrossExposurePct}%
            </strong>
          </span>
        </div>
      </div>
      <section className="panel">
        <SectionHeading title="Open model positions" />
        <div className="responsive-table portfolio-table">
          <div className="table-row table-head">
            <span>Position</span>
            <span>Strategy</span>
            <span>Entry</span>
            <span>Current</span>
            <span>Stop</span>
            <span>Qty</span>
            <span>Unrealized P&L</span>
            <span>Return</span>
            <span>R multiple</span>
          </div>
          {positions.map((p) => (
            <Link className="table-row" to={`/stocks/${p.symbol}`} key={p.symbol}>
              <span data-label="Position">
                <strong>{p.symbol}</strong>
                <small>Opened {formatDate(p.openedAt)}</small>
              </span>
              <span data-label="Strategy">{p.strategy}</span>
              <span data-label="Entry">{formatMoney(p.entryPrice)}</span>
              <span data-label="Current">{formatMoney(p.currentPrice)}</span>
              <span data-label="Stop">{formatMoney(p.stopPrice)}</span>
              <span data-label="Qty">{p.quantity}</span>
              <span
                data-label="Unrealized P&L"
                className={
                  p.unrealizedPnl >= 0 ? "positive-text" : "negative-text"
                }
              >
                {signedMoney(p.unrealizedPnl)}
              </span>
              <span
                data-label="Return"
                className={
                  p.returnPct >= 0 ? "positive-text" : "negative-text"
                }
              >
                {p.returnPct >= 0 ? "+" : ""}
                {p.returnPct}%
              </span>
              <span data-label="R multiple">
                {p.rMultiple >= 0 ? "+" : ""}
                {p.rMultiple}R
              </span>
            </Link>
          ))}
        </div>
      </section>
      <section className="panel">
        <SectionHeading
          title="Risk policy"
          text="Hard limits are deterministic and cannot be changed by AI."
        />
        <div className="risk-grid">
          {[
            ["Risk / trade", "0.5%"],
            ["Max positions", "4"],
            ["Max open risk", "2%"],
            ["Max single position", "30%"],
            ["Max sector exposure", "40%"],
            ["Leverage", "None"],
            ["Averaging down", "Disabled"],
            ["Martingale", "Disabled"],
          ].map(([a, b]) => (
            <span key={a}>
              {a}
              <strong>{b}</strong>
            </span>
          ))}
        </div>
      </section>
    </>
  );
}

type EarningsTab = "today" | "tomorrow" | "week" | "calendar";

export function EarningsPage() {
  const demoData = useData();
  const [tab, setTab] = useState<EarningsTab>("today");
  const [relevantOnly, setRelevantOnly] = useState(true);
  const today = demoData.status.nextScan?.slice(0, 10) ?? "2026-08-11";
  const tomorrow = addDays(today, 1);
  const weekEnd = addDays(today, 6);
  const filtered = useMemo(
    () =>
      demoData.earnings
        .filter((e) => {
          if (relevantOnly && !e.engineRelevant) return false;
          if (tab === "today") return e.date === today;
          if (tab === "tomorrow") return e.date === tomorrow;
          if (tab === "week") return e.date >= today && e.date <= weekEnd;
          return true;
        })
        .sort((a, b) => a.date.localeCompare(b.date)),
    [demoData.earnings, relevantOnly, tab, today, tomorrow, weekEnd],
  );
  const tabs: { id: EarningsTab; label: string }[] = [
    { id: "today", label: "Today" },
    { id: "tomorrow", label: "Tomorrow" },
    { id: "week", label: "This Week" },
    { id: "calendar", label: "Calendar" },
  ];
  return (
    <>
      <PageTitle
        eyebrow="Event calendar"
        title="Earnings"
        text="Upcoming and recent events the engine is tracking, with relevance to current signals and shadow positions."
        action={<Badge tone="demo">Demo Data</Badge>}
      />
      <div className="earnings-toolbar">
        <div className="tabs">
          {tabs.map((t) => (
            <button
              key={t.id}
              className={tab === t.id ? "tab active" : "tab"}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <label className="toggle">
          <input
            type="checkbox"
            checked={relevantOnly}
            onChange={(e) => setRelevantOnly(e.target.checked)}
          />
          <span>Relevant to engine</span>
        </label>
      </div>
      {filtered.length === 0 ? (
        <div className="empty-state">
          <CalendarDays />
          <strong>No earnings in this view</strong>
          <p className="muted">Try another tab or turn off the engine filter.</p>
        </div>
      ) : (
        <div className="earnings-grid">
          {filtered.map((e) => (
            <Link
              to={`/stocks/${e.symbol}`}
              className="earning-card"
              key={`${e.symbol}-${e.date}`}
            >
              <header>
                <span className="ticker-icon">{e.symbol[0]}</span>
                <span>
                  <strong>{e.symbol}</strong>
                  <small>{e.company}</small>
                </span>
                {e.hasPosition && <Badge tone="positive">Position</Badge>}
              </header>
              <div>
                <CalendarDays />
                <span>
                  <small>
                    {e.date < today ? "Reported" : "Expected"} · {e.timing}
                  </small>
                  <strong>{e.date}</strong>
                </span>
              </div>
              <div className="earning-meta">
                {e.signal ? (
                  <SignalBadge status={e.signal} />
                ) : (
                  <Badge tone="neutral">Not tracked</Badge>
                )}
                {e.strategy && <Badge>{e.strategy}</Badge>}
              </div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}

function Timeline({
  compact = false,
  symbol,
}: {
  compact?: boolean;
  symbol?: string;
}) {
  const demoData = useData();
  const events = demoData.events
    .filter((e) => !symbol || e.symbol === symbol || !e.symbol)
    .slice(0, compact ? 5 : undefined);
  return (
    <div className="timeline">
      {events.map((e) => (
        <div key={e.id}>
          <i className={`event-dot event-${e.severity}`} />
          <span>
            <strong>{e.type.replaceAll("_", " ")}</strong>
            <p>{e.message}</p>
            <small>
              {formatDate(e.createdAt)}
              {e.symbol ? ` · ${e.symbol}` : ""}
            </small>
          </span>
        </div>
      ))}
    </div>
  );
}
export function ActivityPage() {
  const demoData = useData();
  const [type, setType] = useState("all");
  const events =
    type === "all"
      ? demoData.events
      : demoData.events.filter((e) => e.type.includes(type));
  return (
    <>
      <PageTitle
        eyebrow="Audit timeline"
        title="Engine activity"
        text="A safe public record of scans, signals and filters."
        action={<Badge tone="demo">Demo Data</Badge>}
      />
      <div className="filter-bar">
        <label>
          <SlidersHorizontal /> Event
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="all">All events</option>
            <option value="SCAN">Scans</option>
            <option value="SIGNAL">Signals</option>
            <option value="FILTER">Filters</option>
            <option value="ERROR">Errors</option>
          </select>
        </label>
      </div>
      <section className="panel">
        <div className="timeline">
          {events.map((e) => (
            <div key={e.id}>
              <i className={`event-dot event-${e.severity}`} />
              <span>
                <strong>{e.type.replaceAll("_", " ")}</strong>
                <p>{e.message}</p>
                <small>
                  {formatDate(e.createdAt)}
                  {e.symbol ? ` · ${e.symbol}` : ""}
                </small>
              </span>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

export function StatusPage() {
  const demoData = useData();
  const s = demoData.status;
  const healthy = s.engine === "online" && s.apiHealth === "healthy";
  const components: [string, string, string][] = [
    [
      "Engine",
      s.engine,
      demoData.demo
        ? "Demo state — no live health claim."
        : "Latest successful scan " + formatDate(s.latestScan),
    ],
    [
      "Market data",
      s.engine === "online" && s.lastDataUpdate ? "current" : "unavailable",
      "Updated " + formatDate(s.lastDataUpdate),
    ],
    ["Earnings data", "operational", "Event calendar synced with the engine"],
    ["AI / event analysis", "operational", "Structured assessments only"],
    [
      "Last successful scan",
      s.engine === "online" ? "completed" : "pending",
      formatDate(s.latestScan),
    ],
    [
      "Next scheduled scan",
      "scheduled",
      formatDate(s.nextScan),
    ],
    ["Data freshness", "current", "Point-in-time timestamps enforced"],
    ["Public sync", "operational", "Read-only public views in sync"],
  ];
  return (
    <>
      <PageTitle
        eyebrow="Safe public health"
        title="System status"
        text="Operational information without private infrastructure details."
        action={<Badge tone="demo">Demo Data</Badge>}
      />
      <div className="system-ok">
        <Check />
        <div>
          <strong>
            {healthy
              ? "All public systems operational"
              : "Public data is delayed or degraded"}
          </strong>
          <span>
            {demoData.demo
              ? "Demo state — no live health claim."
              : "Status derived from the latest public engine heartbeat."}
          </span>
        </div>
      </div>
      <section className="panel status-list">
        {components.map(([name, state, detail]) => {
          const ok = ![
            "offline",
            "delayed",
            "degraded",
            "stale",
            "unavailable",
            "pending",
          ].includes(state);
          return (
            <div key={name}>
              <span className={ok ? "online-dot" : "event-dot event-warning"} />
              <span>
                <strong>{name}</strong>
                <small>{detail}</small>
              </span>
              <Badge tone={ok ? "positive" : "warning"}>{state}</Badge>
            </div>
          );
        })}
      </section>
      <div className="security-note">
        <LockKeyhole />
        <div>
          <strong>Private by design</strong>
          <p>
            This page never exposes server IPs, ports, stack traces, internal
            paths, credentials or private provider status.
          </p>
        </div>
      </div>
    </>
  );
}

function LegalLayout({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="legal-page">
      <header className="landing-nav">
        <Link to="/" className="brand">
          <span className="brand-mark">
            <BarChart3 size={19} />
          </span>
          <span>Stock Autotrader</span>
        </Link>
        <Link className="button button-small" to="/dashboard">
          Dashboard
        </Link>
      </header>
      <main>
        <span className="eyebrow accent-text">Stock Autotrader V5.1</span>
        <h1>{title}</h1>
        {children}
      </main>
      <PublicFooter />
    </div>
  );
}
export function MethodologyPage() {
  return (
    <LegalLayout title="Methodology">
      <p className="lead">
        Stock Autotrader is a systematic research platform. It filters a defined
        US equity universe, calculates deterministic features, applies versioned
        strategy rules and publishes structured outcomes.
      </p>
      <h2>Signal language</h2>
      <p>
        <strong>Strong Setup</strong>, <strong>Watch</strong> and{" "}
        <strong>No Setup</strong> describe model outputs. Bullish, Neutral and
        Bearish are labelled Quant Signal or Model Signal. None is personalised
        advice.
      </p>
      <h2>Decision rationale</h2>
      <p>
        Public rationale contains observable inputs, thresholds and pass/reject
        codes. The system does not publish or store private model
        chain-of-thought.
      </p>
      <h2>Research boundaries</h2>
      <div className="legal-grid">
        <span>
          <strong>Research</strong>2010-01-01 → 2024-12-31
        </span>
        <span>
          <strong>Validation</strong>2025-01-01 → 2025-12-31
        </span>
        <span>
          <strong>Final out-of-sample</strong>2026-01-01 → current
        </span>
      </div>
      <p>
        2026 cannot be used to choose parameters. Tests must address look-ahead
        bias, survivorship bias, point-in-time membership, corporate actions,
        slippage, commission, spreads, gap risk and information availability
        timestamps.
      </p>
      <h2>Shadow mode</h2>
      <p>
        The shadow portfolio uses virtual entries, stops and exits. It does not
        send orders, access a broker or use real capital.
      </p>
    </LegalLayout>
  );
}
export function DisclaimerPage() {
  return (
    <LegalLayout title="Disclaimer">
      <p className="lead">
        Stock Autotrader provides general, model-generated research for
        educational and informational purposes only.
      </p>
      <h2>Not investment advice</h2>
      <p>
        Nothing on this website is a recommendation, offer, solicitation or
        personalised assessment to buy, hold or sell a security. Signals may be
        incomplete, delayed, wrong or unsuitable for you.
      </p>
      <h2>Simulated performance</h2>
      <p>
        Shadow portfolios and demo/backtest results are hypothetical. They do
        not represent actual trading, do not include every real-world constraint
        and must not be presented as guaranteed returns.
      </p>
      <h2>Risk</h2>
      <p>
        Equities and swing trading involve risk, including loss of capital, gaps
        through stops, liquidity changes and data errors. Past or simulated
        performance does not guarantee future results.
      </p>
      <h2>No guarantees</h2>
      <p>
        The service is provided without a guarantee of availability, accuracy,
        completeness or outcome. Verify information independently and seek
        regulated professional advice when needed.
      </p>
    </LegalLayout>
  );
}
export function NotFoundPage() {
  return (
    <div className="not-found">
      <Gauge />
      <h1>Page not found</h1>
      <p>The requested public view does not exist.</p>
      <Link className="button" to="/dashboard">
        Open dashboard
      </Link>
    </div>
  );
}
