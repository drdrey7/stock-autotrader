/**
 * TradingView web-component module loader.
 *
 * The official widgets (`<tv-ticker-tape>`, `<tv-market-overview>`, …) are ES
 * modules hosted on widgets.tradingview-widget.com. Each module registers its
 * custom element when it runs. This loader imports each module exactly once per
 * locale and resolves once the element is upgradeable, so React components can
 * mount the element at any time — before or after the module finishes loading.
 *
 * A failed load is dropped from the cache so a later mount can retry: the
 * homepage must surface a transient TradingView outage as its restrained error
 * state, not a permanently dead module.
 */
const elementModuleCache = new Map<string, Promise<void>>();

const MODULE_BASE_URL = "https://widgets.tradingview-widget.com/w";

/**
 * Import a TradingView web-component module for a locale and wait until its
 * custom element is registered and upgradeable. Safe to call from any number
 * of components — the module is imported exactly once per (locale, element).
 */
export function loadTradingViewElement(locale: string, elementName: string): Promise<void> {
  const cacheKey = `${locale}:${elementName}`;
  let pending = elementModuleCache.get(cacheKey);
  if (!pending) {
    const moduleUrl = `${MODULE_BASE_URL}/${locale}/${elementName}.js`;
    pending = (async () => {
      // @vite-ignore: the URL is runtime-computed (the official TradingView
      // host); Vite must leave this import untouched so the browser performs
      // the real cross-origin module load.
      await import(/* @vite-ignore */ moduleUrl);
      if (!window.customElements.get(elementName)) {
        throw new Error(`TradingView module ${moduleUrl} did not register <${elementName}>`);
      }
      await window.customElements.whenDefined(elementName);
    })();
    pending.catch(() => elementModuleCache.delete(cacheKey));
    elementModuleCache.set(cacheKey, pending);
  }
  return pending;
}
