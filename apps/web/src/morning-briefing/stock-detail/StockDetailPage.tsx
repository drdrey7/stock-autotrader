import { useEffect, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { calculateAutomaticIntrinsicValue, type AutomaticIntrinsicValue } from "@stock-autotrader/contracts";
import FinancialInfoHint from "../../financial-education/FinancialInfoHint";
import type { FinancialGlossaryTerm } from "../../financial-education/financial-glossary";
import { CompanyLogo } from "../EarningsLogo";
import { screenerQueryFromNavigationState, type ScreenerQuery } from "../screener/screener-filter";
import PriceAndKeyLevelsChart from "./PriceAndKeyLevelsChart";
import { apiStockDetailDataSource } from "./stock-detail.api";
import type { StockDetail, StockDetailDataSource } from "./stock-detail.types";
import "./stock-detail.css";
import "./typography.css";

const moneyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function formatMoney(value: number | null): string {
  return value === null ? "—" : moneyFormatter.format(value);
}

function formatNumber(value: number | null, suffix = "", digits = 1): string {
  return value === null ? "—" : `${value.toFixed(digits)}${suffix}`;
}

function formatChange(value: number | null): string {
  if (value === null) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}`;
}

function formatDate(iso: string | null): string {
  if (iso === null) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "America/New_York",
  }).format(date);
}

function formatQuoteFreshness(detail: StockDetail): string {
  if (detail.quote.state === "Unavailable") return "Unavailable";
  if (detail.quote.scaleState !== "safe") return "Split adjustment pending";
  if (detail.quote.state === "Stale") return "Stale data";
  return detail.quote.state;
}

function chartCurrentPrice(detail: StockDetail): number | null {
  if (detail.quote.scaleState !== "safe") return null;
  return detail.quote.state === "Live" || detail.quote.state === "Cached"
    ? detail.quote.price
    : null;
}

function navigationLogoUrl(state: unknown): string | null {
  if (typeof state !== "object" || state === null || !("logoUrl" in state)) return null;
  const value = (state as { logoUrl?: unknown }).logoUrl;
  return typeof value === "string" && value.trim() ? value : null;
}

function ExplainableLabel({ label, term }: { label: string; term: FinancialGlossaryTerm }) {
  return (
    <span className="financial-label">
      <span className="financial-label-text">{label}</span>
      <FinancialInfoHint term={term} />
    </span>
  );
}

/**
 * Automatic IV is calculated at presentation time from values already returned
 * by the Stock Detail read model. Mock fixtures retain their supplied design
 * values so visual tests remain deterministic.
 */
function automaticValuation(detail: StockDetail): AutomaticIntrinsicValue | null {
  if (detail.source !== "api") return null;
  return calculateAutomaticIntrinsicValue(detail.symbol, detail.sector, {
    price: detail.quote.price,
    peTtm: detail.metrics.peTtm,
    priceToBook: detail.metrics.priceToBook ?? null,
  });
}

function selectedIntrinsicValue(detail: StockDetail): number | null {
  return automaticValuation(detail)?.base ?? detail.valuation.intrinsicValue;
}

function IntrinsicValueCard({ detail }: { detail: StockDetail }) {
  const automatic = automaticValuation(detail);
  const intrinsicValue = automatic?.base ?? detail.valuation.intrinsicValue;
  const upsidePct = automatic?.baseUpsidePct ?? detail.valuation.upsidePct;
  const upsideClass = upsidePct === null ? "stock-neutral" : upsidePct >= 0 ? "stock-positive" : "stock-negative";

  return (
    <section className="stock-card stock-iv-card" aria-labelledby="stock-iv-title">
      <h2 id="stock-iv-title"><ExplainableLabel label="Our Intrinsic Value" term="intrinsicValue" /></h2>
      <div className="stock-iv-value">{intrinsicValue === null ? "×" : formatMoney(intrinsicValue)}</div>
      <div className={`stock-iv-upside ${upsideClass}`}>
        {upsidePct === null ? "—" : `${upsidePct > 0 ? "▲ " : upsidePct < 0 ? "▼ " : ""}${formatChange(upsidePct)}%`}
        {upsidePct !== null && <span>{upsidePct >= 0 ? " Upside" : " Downside"}</span>}
      </div>

      <div className={`stock-scenario ${automatic ? "" : "stock-scenario-single"}`} aria-label="Intrinsic value range">
        <div className="stock-scenario-track" aria-hidden="true">
          <span className="stock-scenario-bear-segment" />
          <span className="stock-scenario-base-segment" />
          <span className="stock-scenario-bull-segment" />
          {intrinsicValue !== null && <i className="stock-scenario-marker" />}
        </div>
        {automatic ? (
          <div className="stock-scenario-labels">
            <span><small>Bear</small><b>{formatMoney(automatic.bear)}</b></span>
            <span><small>Base</small><b>{formatMoney(automatic.base)}</b></span>
            <span><small>Bull</small><b>{formatMoney(automatic.bull)}</b></span>
          </div>
        ) : (
          <div className="stock-scenario-labels stock-scenario-labels-single">
            <span><small>IV</small><b>{formatMoney(intrinsicValue)}</b></span>
          </div>
        )}
      </div>
    </section>
  );
}

function ValuationMethodsCard({ detail }: { detail: StockDetail }) {
  const automatic = automaticValuation(detail);
  const manual = detail.valuation.methods.manual ?? detail.valuation.intrinsicValue;
  const rows = [
    ["Automatic Bear", automatic?.bear ?? null],
    ["Automatic Base", automatic?.base ?? null],
    ["Automatic Bull", automatic?.bull ?? null],
    ["Manual", manual],
  ] as const;

  return (
    <section className="stock-card" aria-labelledby="stock-methods-title">
      <h2 id="stock-methods-title"><ExplainableLabel label="Valuation Methods" term="valuationMethods" /></h2>
      <dl className="stock-data-list">
        {rows.map(([label, value]) => (
          <div key={label}><dt>{label}</dt><dd>{formatMoney(value)}</dd></div>
        ))}
        <div className="stock-data-selected">
          <dt>Automatic Method</dt>
          <dd>
            {automatic
              ? `${automatic.method} · ${automatic.bearMultiple}x / ${automatic.baseMultiple}x / ${automatic.bullMultiple}x`
              : "—"}
          </dd>
        </div>
      </dl>
    </section>
  );
}

function KeyLevelsCard({ detail }: { detail: StockDetail }) {
  return (
    <section className="stock-card" aria-labelledby="stock-levels-title">
      <h2 id="stock-levels-title">Key Levels</h2>
      <dl className="stock-data-list stock-levels-list">
        <div>
          <dt><ExplainableLabel label="200W SMA" term="sma200w" /></dt>
          <dd>
            {formatMoney(detail.technical.sma200w)}
            {detail.technical.smaDistancePct !== null && (
              <span className={detail.technical.smaDistancePct >= 0 ? "stock-positive" : "stock-negative"}>
                {detail.technical.smaDistancePct > 0 ? "▲ " : detail.technical.smaDistancePct < 0 ? "▼ " : ""}
                {formatChange(detail.technical.smaDistancePct)}%
              </span>
            )}
          </dd>
        </div>
        {[1, 2, 3, 4].map((level) => {
          const support = detail.technical.supports.find((entry) => entry.level === level);
          return <div key={level}><dt>Support {level} (S{level})</dt><dd>{formatMoney(support?.price ?? null)}</dd></div>;
        })}
      </dl>
    </section>
  );
}

function StockMetrics({ detail }: { detail: StockDetail }) {
  const metrics: ReadonlyArray<readonly [string, string, FinancialGlossaryTerm]> = [
    ["Market Cap", detail.metrics.marketCap ?? "—", "marketCap"],
    ["P/E (TTM)", formatNumber(detail.metrics.peTtm, "", 1), "peTtm"],
    ["ROIC", formatNumber(detail.metrics.roicPct, "%", 1), "roic"],
    ["FCF Margin", formatNumber(detail.metrics.fcfMarginPct, "%", 1), "fcfMargin"],
    ["Debt / Equity", formatNumber(detail.metrics.debtToEquity, "", 2), "debtToEquity"],
  ];
  return (
    <section className="stock-metrics" aria-label="Stock metrics">
      {metrics.map(([label, value, term]) => (
        <div className="stock-metric" key={label}>
          <small><ExplainableLabel label={label} term={term} /></small>
          <strong>{value}</strong>
        </div>
      ))}
    </section>
  );
}

function StockOverview({ detail }: { detail: StockDetail }) {
  const intrinsicValue = selectedIntrinsicValue(detail);
  return (
    <div className="stock-overview">
      <div className="stock-overview-top">
        <IntrinsicValueCard detail={detail} />
        <ValuationMethodsCard detail={detail} />
      </div>
      <div className="stock-overview-middle">
        <KeyLevelsCard detail={detail} />
        <section className="stock-card stock-chart-card" aria-labelledby="stock-chart-title">
          <h2 id="stock-chart-title">Price &amp; Key Levels</h2>
          <PriceAndKeyLevelsChart
            symbol={detail.symbol}
            priceHistory={detail.chart.priceHistory}
            currentPrice={chartCurrentPrice(detail)}
            intrinsicValue={intrinsicValue}
            intrinsicValueHistory={detail.chart.intrinsicValueHistory}
            sma200wHistory={detail.technical.sma200wHistory}
            supports={detail.technical.supports}
          />
        </section>
      </div>
      <StockMetrics detail={detail} />
    </div>
  );
}

function StockDetailReady({
  detail,
  logoUrl,
  returnQuery,
}: {
  detail: StockDetail;
  logoUrl: string | null;
  returnQuery: ScreenerQuery | null;
}) {
  const changePct = detail.quote.changePct;
  const quoteDirection = changePct === null ? "stock-neutral" : changePct > 0 ? "stock-positive" : changePct < 0 ? "stock-negative" : "stock-neutral";
  const exchangeLine = [detail.symbol, detail.exchange, detail.sector].filter(Boolean).join(" · ");
  const backState = returnQuery ? { screenerQuery: returnQuery } : undefined;
  const hasQuoteChange = changePct !== null && detail.quote.change !== null;

  return (
    <div className="page-content inner-page stock-detail-page">
      <Link className="stock-back-link" to="/screener" state={backState} aria-label="Back to Screener">
        <span aria-hidden="true">←</span>
        <span>Back to Screener</span>
      </Link>

      <header className="stock-detail-header">
        <div className="stock-company-row">
          <div className="stock-company-identity">
            <CompanyLogo symbol={detail.symbol} logoUrl={logoUrl} className="stock-company-logo" size={48} />
            <div>
              <h1>{detail.companyName}</h1>
              <p>{exchangeLine || detail.symbol}</p>
            </div>
          </div>
        </div>
        <div className="stock-quote-row">
          <strong>{formatMoney(detail.quote.price)}</strong>
          <span className={quoteDirection}>
            {hasQuoteChange
              ? `${changePct > 0 ? "▲ " : changePct < 0 ? "▼ " : ""}${formatChange(changePct)}% (${formatChange(detail.quote.change)})`
              : "—"}
          </span>
        </div>
        <p className="stock-market-state">
          Market {detail.quote.marketState === "open" ? "Open" : "Closed"} · {formatQuoteFreshness(detail)} · {formatDate(detail.quote.asOf)}
        </p>
      </header>

      <StockOverview detail={detail} />
    </div>
  );
}

interface StockDetailPageProps {
  dataSource?: StockDetailDataSource;
}

export default function StockDetailPage({ dataSource = apiStockDetailDataSource }: StockDetailPageProps = {}) {
  const { symbol: rawSymbol = "" } = useParams<{ symbol: string }>();
  const location = useLocation();
  const symbol = rawSymbol.trim().toUpperCase();
  const routedLogoUrl = navigationLogoUrl(location.state);
  const returnQuery = screenerQueryFromNavigationState(location.state);
  const backState = returnQuery ? { screenerQuery: returnQuery } : undefined;
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ready"; detail: StockDetail }
    | { status: "not-found" }
    | { status: "error" }
  >({ status: "loading" });

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [symbol]);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    dataSource.getStockDetail(symbol)
      .then((detail) => {
        if (cancelled) return;
        setState(detail ? { status: "ready", detail } : { status: "not-found" });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => { cancelled = true; };
  }, [dataSource, symbol]);

  if (state.status === "loading") {
    return <div className="page-content inner-page stock-detail-page" role="status" aria-live="polite"><p className="stock-page-message">Loading stock details…</p></div>;
  }
  if (state.status === "not-found") {
    return <div className="page-content inner-page stock-detail-page"><div className="stock-page-message"><span className="eyebrow">SCREENER</span><h1>Stock not found</h1><p>{symbol || "This symbol"} is not part of the current Core Universe.</p><Link to="/screener" state={backState}>Back to Screener</Link></div></div>;
  }
  if (state.status === "error") {
    return <div className="page-content inner-page stock-detail-page" role="alert"><div className="stock-page-message"><h1>Stock detail unavailable</h1><p>We couldn’t load this stock right now.</p></div></div>;
  }
  return (
    <StockDetailReady
      detail={state.detail}
      logoUrl={state.detail.logoUrl ?? routedLogoUrl}
      returnQuery={returnQuery}
    />
  );
}
