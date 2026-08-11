import {
  ArrowRight,
  BarChart3,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  FileSearch,
  Globe2,
  LineChart,
  Newspaper,
  Radar,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  TriangleAlert,
} from "lucide-react";
import { Link } from "react-router-dom";
import {
  exampleDailyBriefing,
  type BriefingIdea,
  type BriefingVerdict,
} from "./daily-briefing-example";

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <Link className="briefing-brand" to="/" aria-label="Stock Daily Briefing home">
      <span className="briefing-brand-mark" aria-hidden="true">
        <BarChart3 size={18} />
      </span>
      <span>
        Stock Daily Briefing
        {!compact && <small>New York market intelligence</small>}
      </span>
    </Link>
  );
}

function ExampleBadge() {
  return (
    <span className="briefing-example-badge">
      <Sparkles size={12} aria-hidden="true" />
      Example Data
    </span>
  );
}

function BriefingFooter() {
  return (
    <footer className="briefing-footer">
      <span>© 2026 Stock Daily Briefing</span>
      <span className="briefing-footer-links">
        <Link to="/methodology">Methodology</Link>
        <Link to="/status">Status</Link>
        <Link to="/disclaimer">Disclaimer</Link>
      </span>
      <span>Informational research only. Not investment advice.</span>
    </footer>
  );
}

function TerminalPreview() {
  const featured = exampleDailyBriefing.ideas[0]!;

  return (
    <div
      className="briefing-terminal-preview"
      role="img"
      aria-label="Stock Daily Briefing terminal preview"
    >
      <div className="briefing-window-bar">
        <span>
          <i />
          <i />
          <i />
        </span>
        <small>DAILY BRIEF / PRE-MARKET</small>
        <small>08:30 ET</small>
      </div>
      <div className="briefing-preview-strip">
        {exampleDailyBriefing.market.map((item) => (
          <span key={item.symbol}>
            <small>{item.name}</small>
            <strong>{item.value}</strong>
            <em className={item.change.startsWith("+") ? "is-positive" : "is-negative"}>
              {item.change}
            </em>
          </span>
        ))}
      </div>
      <div className="briefing-preview-body">
        <div className="briefing-preview-chart" aria-hidden="true">
          <svg viewBox="0 0 600 220" preserveAspectRatio="none">
            <defs>
              <linearGradient id="preview-fill" x1="0" y1="0" x2="0" y2="1">
                <stop stopColor="#52e0a0" stopOpacity=".32" />
                <stop offset="1" stopColor="#52e0a0" stopOpacity="0" />
              </linearGradient>
            </defs>
            <path
              d="M0 184 C42 176,64 192,98 156 S158 166,194 134 S254 148,294 108 S356 123,398 82 S460 98,502 58 S558 70,600 30 L600 220 L0 220Z"
              fill="url(#preview-fill)"
            />
            <path
              d="M0 184 C42 176,64 192,98 156 S158 166,194 134 S254 148,294 108 S356 123,398 82 S460 98,502 58 S558 70,600 30"
              fill="none"
              stroke="#52e0a0"
              strokeWidth="3"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        </div>
        <div className="briefing-preview-idea">
          <span>
            <small>QUALIFIED IDEA</small>
            <b>01 / 03</b>
          </span>
          <div>
            <strong>{featured.symbol}</strong>
            <em>Potential Entry</em>
          </div>
          <p>{featured.thesis}</p>
          <span className="briefing-preview-levels">
            <small>Trigger {featured.levels.trigger}</small>
            <small>Risk {featured.levels.invalidation}</small>
          </span>
        </div>
      </div>
    </div>
  );
}

export function DailyBriefingLandingPage() {
  return (
    <div className="briefing-landing">
      <header className="briefing-landing-header">
        <Brand />
        <span className="briefing-header-note">
          <CircleDot size={12} aria-hidden="true" /> Public read-only preview
        </span>
      </header>

      <main className="briefing-hero">
        <section className="briefing-hero-copy">
          <ExampleBadge />
          <p className="briefing-kicker">PRE-MARKET · POST-CLOSE · NEW YORK</p>
          <h1>The market, distilled. Twice daily.</h1>
          <p className="briefing-lead">
            A focused briefing for S&amp;P 500 and Nasdaq-100 investors—market context,
            curated ideas and independent qualification in one public terminal.
          </p>
          <Link className="briefing-primary-cta" to="/dashboard">
            View Live Dashboard <ArrowRight size={17} aria-hidden="true" />
          </Link>
          <div className="briefing-trust-row" aria-label="Product principles">
            <span>
              <ShieldCheck size={15} aria-hidden="true" /> Read-only
            </span>
            <span>
              <FileSearch size={15} aria-hidden="true" /> Source-aware
            </span>
            <span>
              <Radar size={15} aria-hidden="true" /> Zero forced ideas
            </span>
          </div>
        </section>
        <TerminalPreview />
      </main>

      <BriefingFooter />
    </div>
  );
}

function VerdictBadge({ verdict }: { verdict: BriefingVerdict }) {
  const className = verdict.toLowerCase().replaceAll(" ", "-");
  return <span className={`briefing-verdict verdict-${className}`}>{verdict}</span>;
}

function MarketStrip() {
  return (
    <section className="briefing-market-strip" aria-label="Example market context">
      {exampleDailyBriefing.market.map((item) => (
        <article key={item.symbol}>
          <header>
            <span>
              <small>{item.symbol}</small>
              <strong>{item.name}</strong>
            </span>
            <em className={item.change.startsWith("+") ? "is-positive" : "is-negative"}>
              {item.change}
            </em>
          </header>
          <div>
            <strong>{item.value}</strong>
            <span>{item.state}</span>
          </div>
          <p>{item.note}</p>
        </article>
      ))}
    </section>
  );
}

function BulletList({ items }: { items: string[] }) {
  return (
    <ul>
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

function IdeaCard({ idea, featured }: { idea: BriefingIdea; featured: boolean }) {
  return (
    <details className="briefing-idea-card" open={featured}>
      <summary>
        <span className="briefing-symbol-block">
          <i>{idea.symbol.slice(0, 1)}</i>
          <span>
            <strong>{idea.symbol}</strong>
            <small>{idea.company}</small>
          </span>
        </span>
        <span className="briefing-price-block">
          <strong>{idea.price}</strong>
          <small className={idea.change.startsWith("+") ? "is-positive" : "is-negative"}>
            {idea.change}
          </small>
        </span>
        <VerdictBadge verdict={idea.verdict} />
        <ChevronDown className="briefing-expand-icon" size={18} aria-hidden="true" />
      </summary>

      <div className="briefing-idea-body">
        <div className="briefing-thesis">
          <span>Editorial view</span>
          <p>{idea.thesis}</p>
        </div>

        <div className="briefing-level-grid">
          <span>
            Trigger<strong>{idea.levels.trigger}</strong>
          </span>
          <span>
            Invalidation<strong>{idea.levels.invalidation}</strong>
          </span>
          <span>
            Objective<strong>{idea.levels.objective}</strong>
          </span>
          <span>
            Reward / risk<strong>{idea.levels.rewardRisk}</strong>
          </span>
        </div>

        <div className="briefing-analysis-grid">
          <section>
            <h3>
              <LineChart size={16} aria-hidden="true" /> Technical confirmation
            </h3>
            <BulletList items={idea.technical} />
          </section>
          <section>
            <h3>
              <TrendingUp size={16} aria-hidden="true" /> Financial context
            </h3>
            <BulletList items={idea.financial} />
          </section>
          <section>
            <h3>
              <Newspaper size={16} aria-hidden="true" /> News check
            </h3>
            <BulletList items={idea.news} />
          </section>
          <section>
            <h3>
              <TriangleAlert size={16} aria-hidden="true" /> Risks
            </h3>
            <BulletList items={idea.risks} />
          </section>
        </div>

        <section className="briefing-provenance">
          <h3>
            <Globe2 size={16} aria-hidden="true" /> Provenance
          </h3>
          <div>
            <span>
              Source<strong>{idea.source.handle}</strong>
            </span>
            <span>
              Reference<strong>{idea.source.reference}</strong>
            </span>
            <span>
              Original<strong>{idea.source.originalTimestamp}</strong>
            </span>
            <span>
              Collected<strong>{idea.source.collectedTimestamp}</strong>
            </span>
          </div>
          <p>{idea.source.summary}</p>
        </section>
      </div>
    </details>
  );
}

export function DailyBriefingDashboardPage() {
  return (
    <div className="briefing-dashboard">
      <header className="briefing-dashboard-header">
        <Brand compact />
        <span className="briefing-dashboard-meta">
          Public terminal <i /> New York
        </span>
        <ExampleBadge />
      </header>

      <main className="briefing-dashboard-main">
        <section className="briefing-dashboard-title">
          <div>
            <p className="briefing-kicker">TUESDAY · AUGUST 11, 2026 · 08:30 ET</p>
            <h1>Pre-market briefing</h1>
            <p>{exampleDailyBriefing.marketSummary}</p>
          </div>
          <span className="briefing-edition-stamp">
            <CalendarClock size={18} aria-hidden="true" />
            <span>
              Edition<strong>PRE / 2026-08-11</strong>
            </span>
          </span>
        </section>

        <MarketStrip />

        <div className="briefing-terminal-grid">
          <section className="briefing-main-column">
            <header className="briefing-section-header">
              <div>
                <span className="briefing-kicker">CURATED DISCOVERY · QUALIFIED INDEPENDENTLY</span>
                <h2>Ideas under review</h2>
              </div>
              <span>
                <Radar size={15} aria-hidden="true" /> Source allowlist: @nolimitgains
              </span>
            </header>

            <div className="briefing-idea-list">
              {exampleDailyBriefing.ideas.map((idea, index) => (
                <IdeaCard key={idea.symbol} idea={idea} featured={index === 0} />
              ))}
            </div>
          </section>

          <aside className="briefing-side-column">
            <section className="briefing-side-card">
              <span className="briefing-kicker">PUBLICATION RHYTHM</span>
              <h2>Two market checkpoints</h2>
              <div className="briefing-schedule-list">
                {exampleDailyBriefing.schedule.map((edition) => (
                  <span key={edition.label}>
                    <i />
                    <span>
                      <small>{edition.label}</small>
                      <strong>{edition.time}</strong>
                      <em>{edition.detail}</em>
                    </span>
                  </span>
                ))}
              </div>
              <p>Timezone: {exampleDailyBriefing.timezone}. Valid market sessions only.</p>
            </section>

            <section className="briefing-side-card">
              <span className="briefing-kicker">SOURCE STATE</span>
              <h2>Transparent by default</h2>
              <div className="briefing-source-state">
                <span>
                  <CheckCircle2 size={16} aria-hidden="true" />
                  <span>
                    <strong>Market context</strong>
                    <small>Illustrative frontend fixture</small>
                  </span>
                </span>
                <span>
                  <CheckCircle2 size={16} aria-hidden="true" />
                  <span>
                    <strong>X discovery</strong>
                    <small>Example summaries, no live integration</small>
                  </span>
                </span>
                <span>
                  <CheckCircle2 size={16} aria-hidden="true" />
                  <span>
                    <strong>Quality gate</strong>
                    <small>Potential Entry, Watch or Avoid</small>
                  </span>
                </span>
              </div>
            </section>

            <section className="briefing-side-card briefing-side-note">
              <ShieldCheck size={20} aria-hidden="true" />
              <div>
                <strong>Ideas are not instructions.</strong>
                <p>
                  Curated posts start research. They never become a recommendation without
                  independent evidence and a complete risk review.
                </p>
              </div>
            </section>
          </aside>
        </div>
      </main>

      <BriefingFooter />
    </div>
  );
}

function InformationLayout({
  eyebrow,
  title,
  lead,
  children,
}: {
  eyebrow: string;
  title: string;
  lead: string;
  children: React.ReactNode;
}) {
  return (
    <div className="briefing-information-page">
      <header className="briefing-information-header">
        <Brand />
        <Link to="/dashboard">Open terminal</Link>
      </header>
      <main>
        <span className="briefing-kicker">{eyebrow}</span>
        <h1>{title}</h1>
        <p className="briefing-information-lead">{lead}</p>
        {children}
      </main>
      <BriefingFooter />
    </div>
  );
}

export function DailyBriefingMethodologyPage() {
  return (
    <InformationLayout
      eyebrow="HOW THE BRIEF IS BUILT"
      title="Methodology"
      lead="Stock Daily Briefing turns a small, explicit source allowlist into independently checked market research."
    >
      <h2>1. Discover, do not endorse</h2>
      <p>
        The X allowlist begins with @nolimitgains. A post is an idea source—not a
        recommendation, score or automatic qualification.
      </p>
      <h2>2. Restrict the universe</h2>
      <p>
        V1 analyses only companies in the S&amp;P 500 or Nasdaq-100. Crypto, ETFs,
        retrospective wins and ambiguous tickers are excluded.
      </p>
      <h2>3. Verify independently</h2>
      <p>
        Market structure, technical context, financial context, material news,
        freshness and risk must agree before an idea can be labelled Potential Entry.
      </p>
      <h2>4. Publish an honest outcome</h2>
      <p>
        Potential Entry, Watch, Avoid and Insufficient Data are informational labels.
        Zero qualified entries is a valid briefing.
      </p>
    </InformationLayout>
  );
}

export function DailyBriefingStatusPage() {
  return (
    <InformationLayout
      eyebrow="PUBLIC PREVIEW HEALTH"
      title="System status"
      lead="This PR validates the public frontend with a clearly labelled example fixture. Live publication arrives in a later release."
    >
      <div className="briefing-status-grid">
        <span>
          <CheckCircle2 aria-hidden="true" />
          <span>
            <strong>Frontend preview</strong>
            <small>Available</small>
          </span>
        </span>
        <span>
          <CheckCircle2 aria-hidden="true" />
          <span>
            <strong>Example fixture</strong>
            <small>Loaded locally</small>
          </span>
        </span>
        <span className="is-pending">
          <CircleDot aria-hidden="true" />
          <span>
            <strong>Live publisher</strong>
            <small>Not connected in PR #6</small>
          </span>
        </span>
      </div>
    </InformationLayout>
  );
}

export function DailyBriefingDisclaimerPage() {
  return (
    <InformationLayout
      eyebrow="READ BEFORE USING THE BRIEF"
      title="Disclaimer"
      lead="Stock Daily Briefing provides general, example market research for informational and educational purposes only."
    >
      <h2>Not investment advice</h2>
      <p>
        Nothing on this website is a recommendation, solicitation or personalised
        assessment to buy, hold or sell a security.
      </p>
      <h2>Example data</h2>
      <p>
        PR #6 uses synthetic, illustrative values. They are not live quotes, current X
        posts or claims about market conditions.
      </p>
      <h2>Risk and verification</h2>
      <p>
        Market information can be delayed, incomplete or wrong. Verify every source and
        assess suitability independently before making financial decisions.
      </p>
    </InformationLayout>
  );
}

export function DailyBriefingNotFoundPage() {
  return (
    <div className="briefing-not-found">
      <Brand />
      <Radar size={42} aria-hidden="true" />
      <h1>Page not found</h1>
      <p>The requested public view does not exist.</p>
      <Link className="briefing-primary-cta" to="/dashboard">
        Open terminal <ArrowRight size={17} aria-hidden="true" />
      </Link>
    </div>
  );
}
