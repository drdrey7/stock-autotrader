import { useEffect, useRef, useState } from "react";
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
  Menu,
  Newspaper,
  Radar,
  ShieldCheck,
  TrendingUp,
  TriangleAlert,
  X as CloseIcon,
} from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import {
  exampleDailyBriefing,
  type BriefingIdea,
  type BriefingVerdict,
} from "./daily-briefing-example";

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <Link className="briefing-brand" to="/" aria-label="Morning Briefing home">
      <span className="briefing-brand-mark" aria-hidden="true">
        <BarChart3 size={18} />
      </span>
      <span>
        Morning Briefing
        {!compact && <small>New York market intelligence</small>}
      </span>
    </Link>
  );
}

function formatBriefingDate(date: string) {
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "long",
    timeZone: exampleDailyBriefing.timezone,
    weekday: "long",
    year: "numeric",
  })
    .format(new Date(`${date}T12:00:00Z`))
    .toUpperCase();
}

function formatBriefingTime(date: string) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    timeZone: exampleDailyBriefing.timezone,
  }).format(new Date(date));
}

function formatBriefingTimezone(date: string) {
  return (
    new Intl.DateTimeFormat("en-US", {
      timeZone: exampleDailyBriefing.timezone,
      timeZoneName: "short",
    })
      .formatToParts(new Date(date))
      .find((part) => part.type === "timeZoneName")?.value ?? "ET"
  );
}

const briefingEditionDate = formatBriefingDate(exampleDailyBriefing.editionDate);
const briefingPreparedTime = formatBriefingTime(exampleDailyBriefing.preparedAt);
const briefingTimezone = formatBriefingTimezone(exampleDailyBriefing.preparedAt);
const briefingEditionLabel =
  exampleDailyBriefing.editionType === "post_close" ? "POST-CLOSE" : "PRE-MARKET";
const briefingEditionCode = exampleDailyBriefing.editionType === "post_close" ? "POST" : "PRE";

function BriefingFooter() {
  return (
    <footer className="briefing-footer">
      <span>© 2026 Morning Briefing</span>
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
  const featured = exampleDailyBriefing.ideas[0];

  return (
    <div
      className="briefing-terminal-preview"
      role="img"
      aria-label="Morning Briefing terminal preview"
    >
      <div className="briefing-window-bar">
        <span>
          <i />
          <i />
          <i />
        </span>
        <small>DAILY BRIEF / {briefingEditionLabel}</small>
        <small>
          {briefingPreparedTime} {briefingTimezone}
        </small>
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
        {featured ? (
          <div className="briefing-preview-idea">
            <span>
              <small>QUALIFIED IDEA</small>
              <b>01 / 03</b>
            </span>
            <div>
              <strong>{featured.symbol}</strong>
              <em>{featured.verdict}</em>
            </div>
            <p>{featured.thesis}</p>
            <span className="briefing-preview-levels">
              <small>Trigger {featured.levels.trigger}</small>
              <small>Risk {featured.levels.invalidation}</small>
            </span>
          </div>
        ) : (
          <div className="briefing-preview-idea">
            <span>
              <small>QUALIFIED IDEAS</small>
              <b>00 / 00</b>
            </span>
            <div>
              <strong>No qualifying ideas</strong>
              <em>Insufficient Data</em>
            </div>
            <p>This example edition has no ideas that passed the qualification gate.</p>
            <span className="briefing-preview-levels">
              <small>Next review follows the next briefing.</small>
            </span>
          </div>
        )}
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
    <section
      id="market-context"
      className="briefing-market-strip"
      aria-label="Example market context"
    >
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

const dashboardMenuItems = [
  {
    label: "Morning briefing",
    detail: "Today",
    href: "#briefing-today",
    Icon: Newspaper,
  },
  {
    label: "X search",
    detail: "Curated source discovery",
    href: "/x",
    Icon: Globe2,
  },
  {
    label: "Earnings",
    detail: "Results and guidance",
    href: undefined,
    Icon: CalendarClock,
  },
] as const;

function DashboardMenu() {
  const [isOpen, setIsOpen] = useState(false);
  const location = useLocation();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLElement>(null);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (!isOpen) {
      if (wasOpenRef.current) {
        wasOpenRef.current = false;
        toggleRef.current?.focus();
      }
      return;
    }

    wasOpenRef.current = true;
    menuRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setIsOpen(false);
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  return (
    <>
      <button
        ref={toggleRef}
        className="briefing-dashboard-menu-toggle"
        type="button"
        aria-controls="briefing-dashboard-menu"
        aria-expanded={isOpen}
        aria-label={isOpen ? "Close dashboard menu" : "Open dashboard menu"}
        onClick={() => setIsOpen((open) => !open)}
      >
        {isOpen ? <CloseIcon size={20} aria-hidden="true" /> : <Menu size={20} aria-hidden="true" />}
      </button>

      {isOpen && (
        <button
          className="briefing-dashboard-menu-backdrop"
          type="button"
          aria-label="Close dashboard menu"
          onClick={() => setIsOpen(false)}
        />
      )}

      <aside
        ref={menuRef}
        id="briefing-dashboard-menu"
        className={`briefing-dashboard-menu${isOpen ? " is-open" : ""}`}
        aria-label="Dashboard menu"
        tabIndex={-1}
      >
        <div className="briefing-dashboard-menu-heading">
          <span className="briefing-kicker">TODAY</span>
          <strong>Dashboard</strong>
          <p>Choose a briefing view.</p>
        </div>

        <nav aria-label="Dashboard sections">
          {dashboardMenuItems.map(({ label, detail, href, Icon }) => {
            if (href) {
              const isInternal = href.startsWith("/");
              const isCurrent = href.startsWith("#")
                ? location.pathname === "/dashboard" && (location.hash === "" || location.hash === href)
                : location.pathname === href;
              const content = (
                <>
                  <Icon size={17} aria-hidden="true" />
                  <span>
                    <small>{detail}</small>
                    <strong>{label}</strong>
                  </span>
                </>
              );
              return isInternal ? (
                <Link
                  key={label}
                  className={`briefing-dashboard-menu-item${isCurrent ? " is-active" : ""}`}
                  to={href}
                  aria-current={isCurrent ? "page" : undefined}
                  onClick={() => setIsOpen(false)}
                >
                  {content}
                </Link>
              ) : (
                <a
                  key={label}
                  className={`briefing-dashboard-menu-item${isCurrent ? " is-active" : ""}`}
                  href={href}
                  aria-current={isCurrent ? "page" : undefined}
                  onClick={() => setIsOpen(false)}
                >
                  {content}
                </a>
              );
            }

            return (
              <button
                key={label}
                className="briefing-dashboard-menu-item is-coming-soon"
                type="button"
                disabled
                aria-label={`Coming soon: ${label}`}
              >
                <Icon size={17} aria-hidden="true" />
                <span>
                  <small>Coming soon</small>
                  <strong>{label}</strong>
                  <em>{detail}</em>
                </span>
              </button>
            );
          })}
        </nav>

        <div className="briefing-dashboard-menu-note">
          <span>Morning briefing</span>
          <p>Read-only market context for independent review.</p>
        </div>
      </aside>
    </>
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

        <div
          id={featured ? "briefing-analysis" : undefined}
          className="briefing-analysis-grid"
        >
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

        <section
          id={featured ? "source-provenance" : undefined}
          className="briefing-provenance"
        >
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
      </header>

      <DashboardMenu />

      <main className="briefing-dashboard-main">
        <section id="briefing-today" className="briefing-dashboard-title">
          <div>
            <p className="briefing-kicker">
              {briefingEditionLabel} · {briefingEditionDate} · {briefingPreparedTime} {briefingTimezone}
            </p>
            <h1>{exampleDailyBriefing.title}</h1>
            <p>{exampleDailyBriefing.marketSummary}</p>
          </div>
          <span className="briefing-edition-stamp">
            <CalendarClock size={18} aria-hidden="true" />
            <span>
              Edition<strong>{briefingEditionCode} / {exampleDailyBriefing.editionDate}</strong>
            </span>
          </span>
        </section>

        <MarketStrip />

        <div className="briefing-terminal-grid">
          <section id="briefing-ideas" className="briefing-main-column">
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
            <section id="publication-rhythm" className="briefing-side-card">
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
              <span className="briefing-kicker">RESEARCH GUARDRAILS</span>
              <h2>Structured for review</h2>
              <div className="briefing-source-state">
                <span>
                  <CheckCircle2 size={16} aria-hidden="true" />
                  <span>
                    <strong>Market context</strong>
                    <small>Indexes and company context in one view</small>
                  </span>
                </span>
                <span>
                  <CheckCircle2 size={16} aria-hidden="true" />
                  <span>
                    <strong>X discovery</strong>
                    <small>Curated posts from tracked accounts</small>
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
  // The dashboard shell (sidebar / mobile drawer) provides all navigation, so
  // the information pages only render their content here — no page-local header
  // or footer chrome.
  return (
    <div className="briefing-information-page">
      <div className="briefing-information-body">
        <span className="briefing-kicker">{eyebrow}</span>
        <h1>{title}</h1>
        <p className="briefing-information-lead">{lead}</p>
        {children}
      </div>
    </div>
  );
}

export function DailyBriefingMethodologyPage() {
  return (
    <InformationLayout
      eyebrow="HOW THE BRIEF IS BUILT"
      title="Methodology"
      lead="Morning Briefing turns a small, explicit source allowlist into independently checked market research."
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
      eyebrow="PUBLIC INFORMATION"
      title="System status"
      lead="Morning Briefing is a public, read-only research interface for market context, curated X Pulse posts and earnings."
    >
      <h2>What is included</h2>
      <p>
        The product brings together a concise morning briefing, selected posts from
        tracked accounts and a monthly earnings calendar. All areas are informational
        and read-only.
      </p>
      <h2>Independent research</h2>
      <p>
        Use the Methodology and Disclaimer pages to understand the research process and
        the limits of the information before making any decision.
      </p>
    </InformationLayout>
  );
}

export function DailyBriefingDisclaimerPage() {
  return (
    <InformationLayout
      eyebrow="READ BEFORE USING THE BRIEF"
      title="Disclaimer"
      lead="Morning Briefing provides general market research for informational and educational purposes only."
    >
      <h2>Not investment advice</h2>
      <p>
        Nothing on this website is a recommendation, solicitation or personalised
        assessment to buy, hold or sell a security.
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
      <Radar size={42} aria-hidden="true" />
      <h1>Page not found</h1>
      <p>The requested public view does not exist.</p>
      <Link className="briefing-primary-cta" to="/dashboard">
        Open terminal <ArrowRight size={17} aria-hidden="true" />
      </Link>
    </div>
  );
}
