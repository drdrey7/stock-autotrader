import type { ReactNode } from "react";
import { Activity, BarChart3, CalendarDays, FlaskConical, Gauge, Home, Menu, Search, ShieldCheck, Target, Wallet, X } from "lucide-react";
import { useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import type { DecisionReason, SignalStatus } from "@stock-autotrader/contracts";
import { useData } from "./lib/data-context";

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "positive" | "warning" | "negative" | "neutral" | "demo" }) {
  const data = useData();
  const replacesDemoLabel = children === "Demo Data" && !data.demo;
  return <span className={`badge badge-${replacesDemoLabel ? "positive" : tone}`}>{replacesDemoLabel ? "Public Data" : children}</span>;
}

export function SignalBadge({ status }: { status: SignalStatus }) {
  const tone = status === "Strong Setup" ? "positive" : status === "Watch" ? "warning" : status === "Rejected" ? "negative" : "neutral";
  return <Badge tone={tone}>{status}</Badge>;
}

export function MetricCard({ label, value, detail, accent }: { label: string; value: ReactNode; detail?: ReactNode; accent?: boolean }) {
  return <article className={`metric-card ${accent ? "metric-accent" : ""}`}><span className="eyebrow">{label}</span><strong>{value}</strong>{detail && <small>{detail}</small>}</article>;
}

export function SectionHeading({ eyebrow, title, text, action }: { eyebrow?: string; title: string; text?: string; action?: ReactNode }) {
  return <div className="section-heading"><div>{eyebrow && <span className="eyebrow accent-text">{eyebrow}</span>}<h2>{title}</h2>{text && <p>{text}</p>}</div>{action}</div>;
}

export function Rationale({ reasons }: { reasons: DecisionReason[] }) {
  return <div className="rationale-list">{reasons.map((reason) => <div className={`reason reason-${reason.outcome}`} key={reason.id}><span>{reason.outcome === "pass" ? "✓" : reason.outcome === "reject" ? "×" : "i"}</span><div><strong>{reason.label}</strong>{reason.observed && <small>{reason.observed}{reason.threshold ? ` · Threshold ${reason.threshold}` : ""}</small>}</div></div>)}</div>;
}

const navItems = [
  ["/dashboard", "Overview", Home], ["/scanner", "Scanner", Search], ["/strategies", "Strategies", Target],
  ["/research", "Research", FlaskConical], ["/portfolio", "Portfolio", Wallet], ["/earnings", "Earnings", CalendarDays],
  ["/activity", "Activity", Activity], ["/status", "Status", Gauge]
] as const;

export function AppShell() {
  const data = useData();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  return <div className="app-shell">
    <aside className={`sidebar ${open ? "sidebar-open" : ""}`}>
      <Link to="/" className="brand" onClick={() => setOpen(false)}><span className="brand-mark"><BarChart3 size={19} /></span><span>Stock Autotrader<small>Systematic Research</small></span></Link>
      <nav>{navItems.map(([to, label, Icon]) => <NavLink key={to} to={to} onClick={() => setOpen(false)}><Icon size={18} />{label}</NavLink>)}</nav>
      <div className="sidebar-note"><ShieldCheck size={18} /><div><strong>Read-only public app</strong><small>No trading controls or broker access.</small></div></div>
    </aside>
    {open && <button className="backdrop" aria-label="Close navigation" onClick={() => setOpen(false)} />}
    <main className="app-main">
      <header className="app-topbar"><button className="menu-button" aria-label="Open navigation" onClick={() => setOpen(!open)}>{open ? <X /> : <Menu />}</button><div><span className="mobile-brand">Stock Autotrader</span><span className="desktop-crumb">{navItems.find(([path]) => location.pathname.startsWith(path))?.[1] ?? "Analysis"}</span></div><Badge tone={data.demo ? "demo" : "positive"}>{data.demo ? "Demo Data" : "Public Data"}</Badge></header>
      <div className="page-container"><Outlet /></div>
    </main>
  </div>;
}

export function PublicFooter() {
  return <footer className="footer"><div className="footer-grid"><div><Link to="/" className="brand"><span className="brand-mark"><BarChart3 size={19} /></span><span>Stock Autotrader<small>Data. Analysis. Opportunity.</small></span></Link></div><div><strong>Product</strong><Link to="/dashboard">Dashboard</Link><Link to="/scanner">Scanner</Link><Link to="/strategies">Strategies</Link></div><div><strong>Research</strong><Link to="/methodology">Methodology</Link><Link to="/research">Backtests</Link><Link to="/status">System Status</Link></div><div><strong>Legal</strong><Link to="/disclaimer">Disclaimer</Link><span>Model-generated signals</span><span>Simulated performance</span></div></div><div className="footer-bottom"><span>© 2026 Stock Autotrader</span><span>Research only. Not investment advice.</span></div></footer>;
}
