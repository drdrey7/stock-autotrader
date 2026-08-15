/* eslint-disable react-refresh/only-export-components */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { motion } from "motion/react";
import { ArrowRight, ExternalLink, Heart, MessageCircle, Repeat2 } from "lucide-react";
import { type XPost } from "./data/xSurge";

/**
 * Building blocks shared between MorningBriefingApp.tsx (the eager shell +
 * default "briefing" page) and the two lazy-loaded pages (XPulsePage,
 * EarningsCalendarPage). Kept dependency-free of both, so neither page
 * importing from here creates a circular import back into the shell — that
 * would defeat the lazy-loading split.
 */

export const spring = { duration: 0.22, ease: [0.22, 1, 0.36, 1] as const };

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <motion.section className={`card ${className}`} whileHover={{ y: -2 }} transition={spring}>{children}</motion.section>;
}

export function SectionTitle({ title, action, onAction, meta }: { title: string; action?: string; onAction?: () => void; meta?: string | null }) {
  return <div className="section-title"><span className="section-title-copy"><h2>{title}</h2>{meta && <span className="section-meta">{meta}</span>}</span>{action && <button onClick={onAction}>{action} <ArrowRight size={14}/></button>}</div>;
}

export function dateFromKey(key: string): Date {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year!, month! - 1, day!, 12);
}

export function dateKeyFromDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function formatUpdatedAt(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const day = new Intl.DateTimeFormat("en", { timeZone: "America/New_York", day: "numeric" }).format(date);
  const month = new Intl.DateTimeFormat("en", { timeZone: "America/New_York", month: "short" }).format(date);
  const time = new Intl.DateTimeFormat("en", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  return `${day} ${month} · ${time}`;
}

export function PostCard({ post, compact = false }: { post: XPost; compact?: boolean }) {
  return <article className={`post-card ${compact ? "compact" : ""}`}><div className="post-head"><span className="avatar" style={{ "--avatar": post.color } as React.CSSProperties}>{post.name.slice(0,1)}</span><span><strong>{post.name}</strong><small>{post.handle}</small></span><span className="post-status"><time>{post.time}</time></span></div><p>{post.text}</p><div className="post-meta"><span><Heart/> {post.likes}</span><span><Repeat2/> {post.reposts}</span><span><MessageCircle/> {post.replies}</span>{!compact && <a href={post.url} target="_blank" rel="noreferrer">Open on X <ExternalLink/></a>}</div></article>;
}

type LazyPageErrorBoundaryProps = { children: ReactNode; resetKey: string };
type LazyPageErrorBoundaryState = { hasError: boolean };

/**
 * A failed dynamic import should recover inside the public shell rather than
 * taking down the whole briefing. The page key lets navigation retry after a
 * failure without relying on a full app remount.
 */
export class LazyPageErrorBoundary extends Component<LazyPageErrorBoundaryProps, LazyPageErrorBoundaryState> {
  state: LazyPageErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): LazyPageErrorBoundaryState {
    return { hasError: true };
  }

  componentDidUpdate(previousProps: LazyPageErrorBoundaryProps): void {
    if (previousProps.resetKey !== this.props.resetKey && this.state.hasError) {
      this.setState({ hasError: false });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Morning Briefing lazy page failed to load", { error, info });
  }

  render() {
    if (this.state.hasError) {
      return <div className="page-content inner-page" role="alert" aria-live="assertive">
        <div className="page-heading">
          <span className="eyebrow">TEMPORARILY UNAVAILABLE</span>
          <h1>Page unavailable</h1>
          <p>We couldn’t load this section. Reload the page to try again.</p>
          <button type="button" className="today" onClick={() => window.location.reload()}>Reload page</button>
        </div>
      </div>;
    }
    return this.props.children;
  }
}

/** Shown by <Suspense> while a lazy page chunk (XPulsePage, EarningsCalendarPage) loads. */
export function PageLoadingFallback() {
  return <div className="page-content inner-page" role="status" aria-live="polite" aria-busy="true"><p className="empty-state">Loading…</p></div>;
}
