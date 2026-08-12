import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

export interface XFeedPost {
  id: string;
  author: string;
  text: string;
  created_at: string;
  url: string;
  symbol: string | null;
  company: string | null;
  universe: string | null;
  collected_at: string;
  chart: number[] | null;
  price: string | null;
  change: string | null;
}

interface XFeedResponse {
  posts: XFeedPost[];
  count: number;
}

type FeedState =
  | { status: "loading" }
  | { status: "ready"; posts: XFeedPost[] }
  | { status: "error"; message: string };

function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const minutes = Math.max(0, Math.floor((now - then) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function highlightTickers(text: string): React.ReactNode[] {
  const parts = text.split(/(\$[A-Z0-9.-]{1,10})/g);
  return parts.map((part, index) =>
    part.startsWith("$") ? (
      <strong key={index} className="x-feed-ticker">
        {part}
      </strong>
    ) : (
      <span key={index}>{part}</span>
    ),
  );
}

function Sparkline({ points }: { points: number[] }) {
  const width = 560;
  const height = 120;
  const pad = 4;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const stepX = (width - pad * 2) / (points.length - 1);
  const coords = points.map((value, index) => {
    const x = pad + index * stepX;
    const y = height - pad - ((value - min) / range) * (height - pad * 2);
    return [x, y] as const;
  });
  const line = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${pad},${height - pad} ${line} ${width - pad},${height - pad}`;
  const up = (points[points.length - 1] ?? 0) >= (points[0] ?? 0);
  const stroke = up ? "#16c784" : "#ea3943";

  return (
    <svg
      className="x-feed-sparkline"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`Sparkline with ${points.length} daily closes`}
    >
      <polygon points={area} fill={stroke} opacity="0.12" />
      <polyline points={line} fill="none" stroke={stroke} strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}

function XPostCard({ post }: { post: XFeedPost }) {
  const initials = post.author.replace("@", "").slice(0, 1).toUpperCase() || "X";
  const normalizedChange = post.change?.trim().replace(/%+$/, "");

  return (
    <article className="x-feed-card">
      <header className="x-feed-card-header">
        <span className="x-feed-avatar" aria-hidden="true">
          {initials}
        </span>
        <div className="x-feed-card-meta">
          <strong>{post.author}</strong>
          <span>·</span>
          <time dateTime={post.created_at}>{formatRelativeTime(post.created_at)}</time>
        </div>
        <a
          className="x-feed-external"
          href={post.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Open post on X"
        >
          ↗
        </a>
      </header>

      <p className="x-feed-text">{highlightTickers(post.text)}</p>

      {post.symbol && (
        <div className="x-feed-stock">
          <span className="x-feed-stock-badge">
            <strong>{post.symbol}</strong>
            {post.company ? <em>{post.company}</em> : null}
            {post.price ? (
              <em className={post.change?.startsWith("-") ? "x-feed-change is-down" : "x-feed-change"}>
                {post.price}
                {normalizedChange ? ` (${normalizedChange}%)` : ""}
              </em>
            ) : null}
          </span>
          {post.chart && post.chart.length >= 2 && <Sparkline points={post.chart} />}
        </div>
      )}
    </article>
  );
}

export function DailyBriefingXSearchPage() {
  const [state, setState] = useState<FeedState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/x/posts?limit=50");
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = (await response.json()) as XFeedResponse;
        if (!cancelled) setState({ status: "ready", posts: payload.posts ?? [] });
      } catch {
        if (!cancelled) setState({ status: "error", message: "X feed unavailable." });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="briefing-page x-feed-page">
      <header className="briefing-page-header">
        <Link className="briefing-back-link" to="/dashboard">
          ← Back to briefing
        </Link>
        <h1>X Search</h1>
        <p className="briefing-page-subtitle">
          Real posts from <strong>@NoLimitGains</strong>, with the stocks mentioned
          and a chart for each setup.
        </p>
      </header>

      {state.status === "loading" && (
        <div className="x-feed-empty" role="status">
          Collecting posts…
        </div>
      )}

      {state.status === "error" && (
        <div className="x-feed-empty" role="alert">
          {state.message}
        </div>
      )}

      {state.status === "ready" && state.posts.length === 0 && (
        <div className="x-feed-empty">
          No posts collected yet. The feed appears here once the source account is
          searched.
        </div>
      )}

      {state.status === "ready" && state.posts.length > 0 && (
        <>
          <div className="x-feed-count">
            {state.posts.length} post{state.posts.length === 1 ? "" : "s"} · latest first
          </div>
          <div className="x-feed-list">
            {state.posts.map((post) => (
              <XPostCard key={post.id} post={post} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
