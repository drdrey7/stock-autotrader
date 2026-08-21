import { useState } from "react";
import { tickerColour } from "./data/earnings-view";

/**
 * Reusable company logo with a graceful deterministic fallback.
 *
 * Primary: persisted Finnhub logo URL (see earnings_universe.logo_url).
 * Fallback: a colored ticker-initial chip, so a broken or missing external
 * logo can never render a broken-image icon. The fallback also covers the
 * period before metadata enrichment reaches a company.
 */
export interface CompanyLogoProps {
  symbol: string;
  logoUrl?: string | null;
  className: string;
  size?: number;
}

export function CompanyLogo({ symbol, logoUrl, className, size }: CompanyLogoProps) {
  const [failed, setFailed] = useState(false);
  const color = tickerColour(symbol);
  if (!failed && logoUrl) {
    return (
      <img
        className={`${className} company-logo-img`}
        src={logoUrl}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        style={size ? { width: size, height: size } : undefined}
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <i
      className={`${className} company-logo-fallback`}
      style={{ "--company": color, ...(size ? { width: size, height: size, fontSize: size * 0.4 } : {}) } as React.CSSProperties}
    >
      {symbol.slice(0, 1)}
    </i>
  );
}