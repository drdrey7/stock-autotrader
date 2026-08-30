import { ArrowUpRight } from "lucide-react";

const symbols = [
  { ticker: "NVDA", label: "compute" },
  { ticker: "AAPL", label: "consumer" },
  { ticker: "MSFT", label: "cloud" },
  { ticker: "AMZN", label: "commerce" },
  { ticker: "META", label: "networks" },
];

/** Quiet market-context layer; text-first to stay fast and accessible. */
export function MarketConstellation() {
  return <div className="market-constellation" aria-label="Representative market symbols">
    <div className="market-constellation-label"><span /> MARKET CONTEXT / REPRESENTATIVE SYMBOLS</div>
    <div className="market-constellation-track">
      {symbols.map((item, index) => <span className={`market-orbit market-orbit-${index + 1}`} key={item.ticker}>
        <span className="market-orbit-dot" aria-hidden="true" />
        <span className="market-symbol">{item.ticker}</span>
        <span className="market-symbol-label">{item.label}</span>
        <ArrowUpRight size={12} aria-hidden="true" />
      </span>)}
    </div>
  </div>;
}
