import { StockHeatmap } from "./TradingView";
import "./heatmap-page.css";

/** Lazy-loaded route: the TradingView heatmap script is never requested on other pages. */
export default function HeatmapPage() {
  return (
    <div className="page-content inner-page heatmap-page">
      <div className="heatmap-heading-row">
        <div className="page-heading">
          <span className="eyebrow">MARKET BREADTH AT A GLANCE</span>
          <h1>Heatmap</h1>
          <p>See where strength and weakness are concentrated across the S&amp;P 500.</p>
        </div>
        <div className="heatmap-context" aria-label="Heatmap settings">
          <span>S&amp;P 500</span>
          <span>1D performance</span>
          <span>Market cap</span>
        </div>
      </div>

      <section className="heatmap-panel" aria-label="S&P 500 stock heatmap">
        <StockHeatmap />
      </section>
    </div>
  );
}
