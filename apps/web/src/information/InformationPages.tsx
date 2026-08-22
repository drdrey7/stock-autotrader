import { ArrowRight, Radar } from "lucide-react";
import { Link } from "react-router-dom";
import { BRAND_NAME } from "../branding/BrandLogo";
import "./information.css";

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
      <div className="briefing-information-body">
        <span className="briefing-kicker">{eyebrow}</span>
        <h1>{title}</h1>
        <p className="briefing-information-lead">{lead}</p>
        {children}
      </div>
    </div>
  );
}

export function DailyBriefingStatusPage() {
  return (
    <InformationLayout
      eyebrow="PUBLIC INFORMATION"
      title="System status"
      lead={`${BRAND_NAME} is a public, read-only research interface for market context, curated X Pulse posts and earnings.`}
    >
      <h2>What is included</h2>
      <p>
        The product brings together a concise morning briefing, selected posts from
        tracked accounts and a monthly earnings calendar. All areas are informational
        and read-only.
      </p>
      <h2>Independent research</h2>
      <p>
        All areas are informational: verify sources and assess suitability independently
        before making any decision.
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
