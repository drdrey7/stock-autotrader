import { useState } from "react";
import { useShellTheme } from "../shell/theme";

export const BRAND_NAME = "How Are The Markets";
export const BRAND_HOME = "/";

interface BrandLogoProps {
  /** Keep the horizontal wordmark readable in the compact mobile header. */
  compact?: boolean;
  /** Prepared for a future mark-only sidebar/mobile treatment. */
  markOnly?: boolean;
  className?: string;
}

/**
 * Central brand asset integration.
 *
 * The approved logo files live in /public/brand. If an asset cannot be loaded,
 * the accessible text fallback keeps the shell usable without introducing a
 * competing monogram or chart icon.
 */
export function BrandLogo({ compact = false, markOnly = false, className = "" }: BrandLogoProps) {
  const { theme } = useShellTheme();
  const [assetReady, setAssetReady] = useState(false);
  const assetName = markOnly ? "logo-mark" : "logo-horizontal";
  const assetPath = `/brand/${assetName}-${theme}.svg`;

  return (
    <span className={`brand-logo${compact ? " is-compact" : ""}${markOnly ? " is-mark-only" : ""}${className ? ` ${className}` : ""}`}>
      <img
        className={`brand-logo-asset${assetReady ? " is-ready" : ""}`}
        src={assetPath}
        alt={markOnly ? "" : BRAND_NAME}
        aria-hidden={markOnly ? true : undefined}
        onLoad={() => setAssetReady(true)}
        onError={() => setAssetReady(false)}
      />
      <span className={`brand-logo-fallback${assetReady ? " is-hidden" : ""}`} aria-hidden={assetReady}>
        <span className="brand-logo-fallback-mark" aria-hidden="true" />
        {!markOnly && (
          <span className="brand-logo-fallback-copy">
            <strong>
              HOW ARE <em>THE MARKETS</em>
            </strong>
            {!compact && <small>Market intelligence</small>}
          </span>
        )}
      </span>
    </span>
  );
}
