import { useState } from "react";
import { useShellTheme } from "../shell/theme";

export const BRAND_NAME = "How Are The Markets";
export const BRAND_HOME = "/";

interface BrandLogoProps {
  /** Keep the wordmark readable in the compact mobile header. */
  compact?: boolean;
  /** Render only the approved brand mark when space is extremely constrained. */
  markOnly?: boolean;
  /** Use the deliberate two-line desktop wordmark instead of clipping it. */
  stacked?: boolean;
  className?: string;
}

/**
 * Central brand asset integration.
 *
 * The approved mark lives in /public/brand. The product name is rendered as
 * normal HTML instead of being embedded inside the SVG, so the sidebar/mobile
 * wordmark cannot disappear because of SVG text sizing/loading behaviour.
 */
export function BrandLogo({
  compact = false,
  markOnly = false,
  stacked = false,
  className = "",
}: BrandLogoProps) {
  const { theme } = useShellTheme();
  const [assetReady, setAssetReady] = useState(false);
  const assetPath = `/brand/logo-mark-${theme}.svg`;

  const wordmarkStyle = stacked
    ? {
        overflow: "visible",
        textOverflow: "clip",
        whiteSpace: "normal" as const,
      }
    : compact
      ? {
          overflow: "visible",
          textOverflow: "clip",
          whiteSpace: "nowrap" as const,
        }
      : undefined;

  return (
    <span
      className={`brand-logo${compact ? " is-compact" : ""}${markOnly ? " is-mark-only" : ""}${stacked ? " is-stacked" : ""}${className ? ` ${className}` : ""}`}
    >
      <span className="brand-logo-fallback">
        <img
          className={`brand-logo-asset${assetReady ? " is-ready" : ""}`}
          src={assetPath}
          width="38"
          height="38"
          alt=""
          aria-hidden="true"
          onLoad={() => setAssetReady(true)}
          onError={() => setAssetReady(false)}
        />
        {!assetReady && <span className="brand-logo-fallback-mark" aria-hidden="true" />}
        {!markOnly && (
          <span
            className="brand-logo-fallback-copy"
            style={compact ? { minWidth: "max-content" } : undefined}
          >
            <strong style={wordmarkStyle}>
              {stacked ? (
                <>
                  HOW ARE
                  <br />
                  <em>THE</em> MARKETS
                </>
              ) : (
                <>HOW ARE <em>THE</em> MARKETS</>
              )}
            </strong>
            {!compact && !stacked && <small>Market intelligence</small>}
          </span>
        )}
      </span>
    </span>
  );
}
