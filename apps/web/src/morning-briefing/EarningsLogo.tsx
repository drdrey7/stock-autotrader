import { useState } from "react";
import type { EarningsCompany } from "./data/earnings-view";

/**
 * Company logo with a graceful deterministic fallback.
 *
 * Primary: persisted Finnhub logo URL (see earnings_universe.logo_url).
 * Fallback: a colored ticker-initial chip, so a broken or missing external
 * logo can never render a broken-image icon. The fallback also covers the
 * period before metadata enrichment reaches a company.
 */
export function CompanyLogo({ event, className }: { event: Pick<EarningsCompany, "symbol" | "logoUrl" | "color">; className: string }) {
  const [failed, setFailed] = useState(false);
  if (!failed && event.logoUrl) {
    return (
      <img
        className={`${className} company-logo-img`}
        src={event.logoUrl}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <i className={`${className} company-logo-fallback`} style={{ "--company": event.color } as React.CSSProperties}>
      {event.symbol.slice(0, 1)}
    </i>
  );
}