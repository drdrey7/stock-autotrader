import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown, Search, X } from "lucide-react";
import type { AiAnalysisCatalogResponse } from "@stock-autotrader/contracts";

export type AiAnalysisStock = AiAnalysisCatalogResponse["stocks"][number];

interface StockSelectorProps {
  stocks: readonly AiAnalysisStock[];
  selected: AiAnalysisStock | null;
  ownedSymbols: ReadonlySet<string>;
  onSelect: (stock: AiAnalysisStock | null) => void;
}

function stockLabel(stock: AiAnalysisStock): string {
  return `${stock.symbol} — ${stock.company}`;
}

function searchMatches(stock: AiAnalysisStock, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return true;
  return stock.symbol.toLocaleLowerCase().includes(normalized)
    || stock.company.toLocaleLowerCase().includes(normalized)
    || stockLabel(stock).toLocaleLowerCase().includes(normalized);
}

export function StockSelector({ stocks, selected, ownedSymbols, onSelect }: StockSelectorProps) {
  const [query, setQuery] = useState(() => selected ? stockLabel(selected) : "");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = "ai-analysis-stock-options";

  const filtered = useMemo(
    () => stocks.filter((stock) => searchMatches(stock, query)),
    [query, stocks],
  );

  useEffect(() => {
    if (selected) setQuery(stockLabel(selected));
  }, [selected]);

  useEffect(() => {
    setActiveIndex((current) => Math.min(current, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, [open]);

  const choose = (stock: AiAnalysisStock) => {
    onSelect(stock);
    setQuery(stockLabel(stock));
    inputRef.current?.focus();
    setOpen(false);
  };

  const clear = () => {
    onSelect(null);
    setQuery("");
    setActiveIndex(0);
    setOpen(true);
    inputRef.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        setOpen(false);
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setOpen(true);
      const lastIndex = Math.max(0, filtered.length - 1);
      setActiveIndex((current) => {
        if (event.key === "Home") return 0;
        if (event.key === "End") return lastIndex;
        if (event.key === "ArrowDown") return Math.min(current + 1, lastIndex);
        return Math.max(current - 1, 0);
      });
      return;
    }
    if (event.key === "Enter" && open && filtered[activeIndex]) {
      event.preventDefault();
      choose(filtered[activeIndex]);
    }
  };

  const activeOptionId = open && filtered[activeIndex]
    ? `ai-analysis-stock-${filtered[activeIndex].symbol}`
    : undefined;

  return (
    <div className="ai-stock-field">
      <label htmlFor="ai-analysis-stock-search">Choose a Core Universe stock</label>
      <div className="ai-stock-selector" ref={rootRef}>
        <Search className="ai-stock-search-icon" size={18} aria-hidden="true" />
        <input
          ref={inputRef}
          id="ai-analysis-stock-search"
          type="search"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-activedescendant={activeOptionId}
          autoComplete="off"
          placeholder="Search symbol or company…"
          value={query}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value);
            if (selected && event.target.value !== stockLabel(selected)) onSelect(null);
            setActiveIndex(0);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
        />
        {query ? (
          <button className="ai-stock-clear" type="button" aria-label="Clear stock selection" onClick={clear}>
            <X size={17} aria-hidden="true" />
          </button>
        ) : <ChevronDown className="ai-stock-caret" size={18} aria-hidden="true" />}

        {open ? (
          <ul id={listboxId} className="ai-stock-options" role="listbox" aria-label="Core Universe stocks">
            {filtered.length ? filtered.map((stock, index) => {
              const owned = ownedSymbols.has(stock.symbol);
              return (
                <li
                  id={`ai-analysis-stock-${stock.symbol}`}
                  key={stock.symbol}
                  role="option"
                  aria-selected={selected?.symbol === stock.symbol}
                  className={index === activeIndex ? "is-active" : ""}
                  onMouseEnter={() => setActiveIndex(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(stock)}
                >
                  <span className="ai-stock-option-copy">
                    <strong>{stock.symbol}</strong>
                    <span>{stock.company}</span>
                  </span>
                  {owned ? (
                    <span className="ai-stock-owned" title="Previously analyzed">
                      <Check size={15} aria-hidden="true" />
                      <span className="ai-visually-hidden">Previously analyzed</span>
                    </span>
                  ) : null}
                </li>
              );
            }) : (
              <li className="ai-stock-no-results" role="option" aria-disabled="true">
                No matching Core Universe stock.
              </li>
            )}
          </ul>
        ) : null}
      </div>
      <p className="ai-stock-help">Search the existing 50-stock Core Universe by ticker or company.</p>
    </div>
  );
}
